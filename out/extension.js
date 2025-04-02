"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
function activate(context) {
    console.log('Sua extensão "minha-extensao" está ativa!');
    let disposable = vscode.commands.registerCommand('minha-extensao.novaExtensao', () => {
        vscode.window.showInformationMessage('🎉 Nova extensão ativada!', { modal: false });
    });
    context.subscriptions.push(disposable);
}
function deactivate() { }
//# sourceMappingURL=extension.js.map