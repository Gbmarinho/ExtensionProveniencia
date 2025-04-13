const vscode = require('vscode');
const { exec } = require('child_process');
const path = require('path');
const fetch = require('node-fetch');

function getGitChangedFiles(workspaceRoot) {
    return new Promise((resolve, reject) => {
        exec('git diff-tree --no-commit-id --name-only -r HEAD', { cwd: workspaceRoot }, (error, stdout, stderr) => {
            if (error) {
                reject(error);
                return;
            }
            const files = stdout.trim().split('\n').filter(file => file);
            resolve(files);
        });
    });
}

function getLastCommitMessage(workspaceRoot) {
    return new Promise((resolve, reject) => {
        exec('git log -1 --pretty=%B', { cwd: workspaceRoot }, (error, stdout, stderr) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(stdout.trim());
        });
    });
}

async function checkForNewCommit(workspaceRoot, lastCommitHash) {
    return new Promise((resolve, reject) => {
        exec('git rev-parse HEAD', { cwd: workspaceRoot }, (error, stdout, stderr) => {
            if (error) {
                reject(error);
                return;
            }
            const currentHash = stdout.trim();
            resolve(currentHash !== lastCommitHash ? currentHash : null);
        });
    });
}

async function generateDocumentation(fileUri) {
    try {
        // Lê o conteúdo do arquivo
        const fileContent = await vscode.workspace.fs.readFile(fileUri);
        const content = Buffer.from(fileContent).toString('utf8');

        // Gera o nome do arquivo de documentação
        const filePath = fileUri.fsPath;
        const fileExtension = path.extname(filePath);
        const baseFileName = path.basename(filePath, fileExtension);
        const docFileName = `${baseFileName}-Doc.md`;
        const docFilePath = path.join(path.dirname(filePath), docFileName);

        let documentation = `# Documentação do arquivo "${path.basename(filePath)}"

`;

        try {
            // Gera a documentação usando a API do Hugging Face
            const response = await fetch('https://api-inference.huggingface.co/models/Salesforce/codegen-350M-mono', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    inputs: `Crie uma documentação detalhada em markdown para este código, explicando todas as funções e o propósito do arquivo:\n${content}`,
                    parameters: {
                        max_length: 1000,
                        temperature: 0.7
                    }
                })
            });

            if (!response.ok) {
                throw new Error(`Erro na API: ${response.status}`);
            }

            const data = await response.json();
            if (Array.isArray(data) && data.length > 0) {
                documentation += data[0].generated_text;
            } else {
                documentation += '**Não foi possível gerar a documentação automática.**';
            }
        } catch (apiError) {
            documentation += `**Erro ao gerar documentação automática:**

\`\`\`
${apiError.message}
\`\`\`
`;
        }

        // Cria o arquivo de documentação
        const docUri = vscode.Uri.file(docFilePath);
        await vscode.workspace.fs.writeFile(docUri, Buffer.from(documentation));

        // Abre o arquivo de documentação
        const doc = await vscode.workspace.openTextDocument(docUri);
        await vscode.window.showTextDocument(doc);

        vscode.window.showInformationMessage(`Arquivo de documentação criado: ${docFileName}`);
    } catch (error) {
        vscode.window.showErrorMessage(`Erro ao criar arquivo de documentação: ${error.message}`);
        console.error('Erro completo:', error);
    }
}

function activate(context) {
    console.log('Extensão de monitoramento de commits está ativa!');

    // Registra o comando de criar documentação
    let disposable = vscode.commands.registerCommand('minha-extensao.criarDocumentacao', (fileUri) => {
        if (!fileUri) {
            vscode.window.showErrorMessage('Por favor, clique com o botão direito em um arquivo para gerar a documentação.');
            return;
        }
        generateDocumentation(fileUri);
    });
    context.subscriptions.push(disposable);

    let lastCommitHash = '';
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    if (!workspaceRoot) {
        console.log('Nenhum workspace aberto');
        return;
    }

    exec('git rev-parse HEAD', { cwd: workspaceRoot }, (error, stdout) => {
        if (!error) {
            lastCommitHash = stdout.trim();
        }
    });

    const interval = setInterval(async () => {
        try {
            const newHash = await checkForNewCommit(workspaceRoot, lastCommitHash);
            if (newHash) {
                lastCommitHash = newHash;
                const commitMessage = await getLastCommitMessage(workspaceRoot);
                const changedFiles = await getGitChangedFiles(workspaceRoot);
    
                let message = commitMessage + '\n\nArquivos alterados:\n';
                for (const file of changedFiles) {
                    message += '• ' + file + '\n';
                    try {
                        const fileContent = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(workspaceRoot, file)));
                        const content = Buffer.from(fileContent).toString('utf8');
                        const suggestions = await getCodeSuggestions(content);
                        message += '  Sugestões de melhoria:\n';
                        message += '  ' + suggestions + '\n\n';
                    } catch (error) {
                        console.error(`Erro ao analisar arquivo ${file}:`, error);
                        message += '  Erro ao gerar sugestões para este arquivo\n\n';
                    }
                }
    
                vscode.window.showInformationMessage(
                    'Novo commit detectado! Clique para ver detalhes.',
                    'Ver Detalhes'
                ).then(selection => {
                    if (selection === 'Ver Detalhes') {
                        const doc = vscode.workspace.openTextDocument({ content: message });
                        vscode.window.showTextDocument(doc);
                    }
                });
            }
        } catch (error) {
            console.error('Erro ao verificar commits:', error);
        }
    }, 2000);

    context.subscriptions.push({
        dispose: () => clearInterval(interval)
    });
}

async function getCodeSuggestions(code) {
    try {
        const response = await fetch('https://api-inference.huggingface.co/models/Salesforce/codegen-350M-mono', {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                inputs: `Analise este código e forneça sugestões de melhoria:\n${code}`,
                parameters: {
                    max_length: 150,
                    temperature: 0.7
                }
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP error! status: ${response.status}, details: ${errorText}`);
        }

        const data = await response.json();
        return Array.isArray(data) && data.length > 0 ? data[0].generated_text : 'Nenhuma sugestão disponível no momento.';

    } catch (error) {
        console.error('Erro ao obter sugestões:', error);
        return `Erro ao gerar sugestões. Por favor, tente novamente mais tarde. ${error}`;
    }
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
}
