const vscode = require('vscode');
const { exec } = require('child_process');
const path = require('path');
const fetch = require('node-fetch');
const fs = require('fs').promises;

class FileHistoryProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.currentFile = null;
        this.commits = [];
    }

    async setCurrentFile(filePath) {
        this.currentFile = filePath;
        await this.refreshCommits();
        this._onDidChangeTreeData.fire();
    }

    async refreshCommits() {
        if (!this.currentFile) {
            this.commits = [];
            return;
        }

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            throw new Error('Nenhum workspace aberto');
        }

        const relativePath = path.relative(workspaceRoot, this.currentFile);

        try {
            const commits = await new Promise((resolve, reject) => {
                exec(
                    `git log --pretty=format:"%H|%s|%ae|%ai" -- ${relativePath}`,
                    { cwd: workspaceRoot },
                    (error, stdout) => {
                        if (error) {
                            reject(error);
                            return;
                        }
                        const lines = stdout.trim().split('\n');
                        const commits = lines.map(line => {
                            const [hash, subject, author, date] = line.split('|');
                            return { hash, subject, author, date };
                        });
                        resolve(commits);
                    }
                );
            });

            this.commits = commits;
        } catch (error) {
            console.error('Erro ao obter histórico:', error);
            this.commits = [];
            throw error;
        }
    }

    getTreeItem(element) {
        const treeItem = new vscode.TreeItem(
            `${element.subject} (${new Date(element.date).toLocaleDateString()})`,
            vscode.TreeItemCollapsibleState.None
        );
        
        treeItem.description = `por ${element.author}`;
        treeItem.tooltip = `Hash: ${element.hash}\nAutor: ${element.author}\nData: ${element.date}`;
        treeItem.command = {
            command: 'minha-extensao.abrirDiff',
            title: 'Abrir Diff',
            arguments: [this.currentFile, element.hash]
        };
        treeItem.iconPath = new vscode.ThemeIcon('git-commit');
        
        return treeItem;
    }

    getChildren(element) {
        if (element) {
            return [];
        }
        return this.commits;
    }
}

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

async function getGitInfo(workspaceRoot) {
    try {
        const [commitMsg, branch, email] = await Promise.all([
            new Promise((resolve, reject) => {
                exec('git log -1 --pretty=%B', { cwd: workspaceRoot }, (error, stdout) => {
                    if (error) reject(error);
                    else resolve(stdout.trim());
                });
            }),
            new Promise((resolve, reject) => {
                exec('git rev-parse --abbrev-ref HEAD', { cwd: workspaceRoot }, (error, stdout) => {
                    if (error) reject(error);
                    else resolve(stdout.trim());
                });
            }),
            new Promise((resolve, reject) => {
                exec('git log -1 --pretty=%ae', { cwd: workspaceRoot }, (error, stdout) => {
                    if (error) reject(error);
                    else resolve(stdout.trim());
                });
            })
        ]);

        return { commitMsg, branch, email };
    } catch (error) {
        console.error('Erro ao obter informações do git:', error);
        throw error;
    }
}

async function generateCommitSummary(commitInfo, changedFiles) {
    try {
        const filesContent = changedFiles.map(file => `- ${file}`).join('\n');
        const prompt = `Analise este commit e gere um resumo detalhado do que foi feito:\n\nMensagem do commit: ${commitInfo.commitMsg}\n\nArquivos alterados:\n${filesContent}`;

        const response = await fetch('https://api-inference.huggingface.co/models/Salesforce/codegen-350M-mono', {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                inputs: prompt,
                parameters: {
                    max_length: 500,
                    temperature: 0.7
                }
            })
        });

        if (!response.ok) {
            throw new Error(`Erro na API: ${response.status}`);
        }

        const data = await response.json();
        return Array.isArray(data) && data.length > 0 ? 
            data[0].generated_text : 
            'Não foi possível gerar um resumo detalhado para este commit.';
    } catch (error) {
        console.error('Erro ao gerar resumo do commit:', error);
        return `Não foi possível gerar um resumo detalhado para este commit. Erro: ${error.message}`;
    }
}

async function updateUpgradeLog(workspaceRoot, commitInfo, changedFiles) {
    try {
        const upgradeLogPath = path.join(workspaceRoot, 'Upgrade-log.md');
        let existingContent = '';

        try {
            const fileUri = vscode.Uri.file(upgradeLogPath);
            const fileContent = await vscode.workspace.fs.readFile(fileUri);
            existingContent = Buffer.from(fileContent).toString('utf8');
        } catch (error) {
            // Arquivo não existe ainda, começaremos um novo
            existingContent = '# Histórico de Atualizações\n\n';
        }

        const summary = await generateCommitSummary(commitInfo, changedFiles);

        const newEntry = `## Commit "${commitInfo.commitMsg}"\n` +
            `**Branch:** ${commitInfo.branch}\n` +
            `**Responsável:** ${commitInfo.email}\n\n` +
            `${summary}\n\n---\n\n`;

        const newContent = existingContent.includes('# Histórico de Atualizações') ?
            existingContent.replace('# Histórico de Atualizações\n\n', `# Histórico de Atualizações\n\n${newEntry}`) :
            `# Histórico de Atualizações\n\n${newEntry}${existingContent}`;

        const fileUri = vscode.Uri.file(upgradeLogPath);
        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(newContent));

        return upgradeLogPath;
    } catch (error) {
        console.error('Erro ao atualizar Upgrade-log:', error);
        throw error;
    }
}

async function findTodos(workspaceRoot) {
    try {
        // Busca por arquivos no projeto, excluindo node_modules e .git
        const findFiles = new Promise((resolve, reject) => {
            exec('find . -type f -not -path "*/\.*" -not -path "*/node_modules/*"', 
                { cwd: workspaceRoot }, 
                (error, stdout) => {
                    if (error) reject(error);
                    else resolve(stdout.trim().split('\n'));
                }
            );
        });

        const files = await findFiles;
        const todos = [];

        for (const file of files) {
            if (file) {
                const filePath = path.join(workspaceRoot, file.slice(2)); // remove './' do início
                try {
                    const content = await fs.readFile(filePath, 'utf-8');
                    const lines = content.split('\n');

                    lines.forEach((line, index) => {
                        // Busca por diferentes formatos de TODO
                        const todoPatterns = [
                            /\/\/\s*TODO:?\s*(.+)/, // Para // TODO
                            /\/\*\s*TODO:?\s*(.+)\*\//, // Para /* TODO */
                            /#\s*TODO:?\s*(.+)/, // Para # TODO
                            /<!--\s*TODO:?\s*(.+)-->/ // Para <!-- TODO -->
                        ];

                        for (const pattern of todoPatterns) {
                            const match = line.match(pattern);
                            if (match) {
                                todos.push({
                                    file: file.slice(2),
                                    line: index + 1,
                                    text: match[1].trim()
                                });
                                break;
                            }
                        }
                    });
                } catch (error) {
                    console.error(`Erro ao ler arquivo ${file}:`, error);
                }
            }
        }

        return todos;
    } catch (error) {
        console.error('Erro ao buscar TODOs:', error);
        throw error;
    }
}

async function updateTodosFile(workspaceRoot, todos) {
    try {
        const todosPath = path.join(workspaceRoot, 'TODOs.md');
        let content = '# Lista de TODOs\n\n';
        content += 'Última atualização: ' + new Date().toLocaleString() + '\n\n';

        if (todos.length === 0) {
            content += 'Nenhum TODO encontrado no projeto.\n';
        } else {
            for (const todo of todos) {
                content += `## ${todo.file}:${todo.line}\n`;
                content += `${todo.text}\n\n`;
            }
        }

        await fs.writeFile(todosPath, content, 'utf-8');
        console.log('Arquivo TODOs.md atualizado com sucesso');
    } catch (error) {
        console.error('Erro ao atualizar arquivo TODOs.md:', error);
        throw error;
    }
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

    // Inicializa o provedor de histórico de arquivos
    const fileHistoryProvider = new FileHistoryProvider();
    const treeView = vscode.window.createTreeView('historicoArquivoView', {
        treeDataProvider: fileHistoryProvider
    });

    // Registra o comando para mostrar histórico
    let disposableShowHistory = vscode.commands.registerCommand(
        'minha-extensao.mostrarHistoricoArquivo',
        (fileUri) => {
            let filePath;
            if (fileUri) {
                filePath = fileUri.fsPath;
            } else {
                const activeEditor = vscode.window.activeTextEditor;
                if (!activeEditor) {
                    vscode.window.showErrorMessage('Nenhum arquivo selecionado');
                    return;
                }
                filePath = activeEditor.document.uri.fsPath;
            }

            fileHistoryProvider.setCurrentFile(filePath);
            treeView.reveal(treeView.selection[0], { expand: true, focus: true });
        }
    );

    // Registra o comando para abrir diff
    let disposableOpenDiff = vscode.commands.registerCommand(
        'minha-extensao.abrirDiff',
        async (filePath, commitHash) => {
            try {
                const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (!workspaceRoot) {
                    throw new Error('Nenhum workspace aberto');
                }

                // Cria um arquivo temporário com o conteúdo do commit
                const relativePath = path.relative(workspaceRoot, filePath);
                const tempFile = path.join(workspaceRoot, `.tmp-${path.basename(filePath)}-${commitHash}`);

                // Obtém o conteúdo do arquivo no commit
                await new Promise((resolve, reject) => {
                    exec(
                        `git show ${commitHash}:${relativePath}`,
                        { cwd: workspaceRoot },
                        async (error, stdout) => {
                            if (error) {
                                reject(error);
                                return;
                            }

                            try {
                                await fs.writeFile(tempFile, stdout);
                                resolve();
                            } catch (writeError) {
                                reject(writeError);
                            }
                        }
                    );
                });

                // Abre o diff
                const uri1 = vscode.Uri.file(tempFile);
                const uri2 = vscode.Uri.file(filePath);
                await vscode.commands.executeCommand('vscode.diff', uri1, uri2, 
                    `${path.basename(filePath)} (${commitHash} vs. Atual)`);

                // Remove o arquivo temporário após um breve delay
                setTimeout(async () => {
                    try {
                        await fs.unlink(tempFile);
                    } catch (error) {
                        console.error('Erro ao remover arquivo temporário:', error);
                    }
                }, 1000);

            } catch (error) {
                vscode.window.showErrorMessage(`Erro ao abrir diff: ${error.message}`);
                console.error('Erro completo:', error);
            }
        }
    );

    context.subscriptions.push(disposableShowHistory, disposableOpenDiff, treeView);

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
                const commitInfo = await getGitInfo(workspaceRoot);
                const changedFiles = await getGitChangedFiles(workspaceRoot);

                // Atualiza o arquivo de TODOs
                try {
                    const todos = await findTodos(workspaceRoot);
                    await updateTodosFile(workspaceRoot, todos);
                } catch (error) {
                    console.error('Erro ao atualizar TODOs:', error);
                }
                
                // Atualiza o Upgrade-log.md
                try {
                    const upgradeLogPath = await updateUpgradeLog(workspaceRoot, commitInfo, changedFiles);
                    console.log('Upgrade-log atualizado com sucesso:', upgradeLogPath);
                } catch (error) {
                    console.error('Erro ao atualizar Upgrade-log:', error);
                }
    
                let message = commitInfo.commitMsg + '\n\nArquivos alterados:\n';
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
