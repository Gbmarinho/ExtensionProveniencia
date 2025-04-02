const vscode = require('vscode');

function activate(context) {
    console.log('Sua extensão "minha-extensao" está ativa!');

    let disposable = vscode.commands.registerCommand('minha-extensao.novaExtensao', function () {
        const mensagem = '👋 Bem-vindo(a)! Que bom ter você por aqui!';
        const opcoes = ['Obrigado!', 'Legal! 😊'];
        
        vscode.window.showInformationMessage(mensagem, ...opcoes).then(selecao => {
            if (selecao === 'Obrigado!') {
                vscode.window.showInformationMessage('✨ De nada! Estamos juntos!');
            } else if (selecao === 'Legal! 😊') {
                vscode.window.showInformationMessage('🎉 Sim, vai ser muito legal!');
            }
        });
    });

    context.subscriptions.push(disposable);
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
}
