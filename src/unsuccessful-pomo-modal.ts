
import { App, Modal, Setting, ButtonComponent } from 'obsidian';

export class UnsuccessfulPomoModal extends Modal {
    private reason: string = "";
    private onSubmit: (reason: string) => void;

    constructor(app: App, onSubmit: (reason: string) => void) {
        super(app);
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: 'Unsuccessful Pomodoro' });

        new Setting(contentEl)
            .setName('Reason')
            .setDesc('Why was this pomodoro unsuccessful? (Optional)')
            .addTextArea(text =>
                text
                    .setValue(this.reason)
                    .onChange(value => {
                        this.reason = value;
                    })
            );

        new Setting(contentEl)
            .addButton(btn =>
                btn
                    .setButtonText('Log')
                    .setCta()
                    .onClick(() => {
                        this.close();
                        this.onSubmit(this.reason);
                    })
            )
            .addButton(btn =>
                btn
                    .setButtonText('Cancel')
                    .onClick(() => {
                        this.close();
                    })
            );
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
