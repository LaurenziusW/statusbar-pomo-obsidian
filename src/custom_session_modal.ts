import { App, Modal, Setting } from 'obsidian';
import PomoTimerPlugin from './main';

export class CustomSessionModal extends Modal {
    plugin: PomoTimerPlugin;
    pomo: number;
    break: number;
    logToNote: boolean;
    logNote: string;
    onSubmit: (pomo: number, shortBreak: number, logToNote: boolean, logNote: string) => void;

    constructor(app: App, plugin: PomoTimerPlugin, onSubmit: (pomo: number, shortBreak: number, logToNote: boolean, logNote: string) => void) {
        super(app);
        this.plugin = plugin;
        this.pomo = plugin.settings.customPomo;
        this.break = plugin.settings.customBreak;
        this.logToNote = plugin.settings.logToNote;
        this.logNote = plugin.settings.logNote;
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'Custom Session' });

        new Setting(contentEl)
            .setName('Pomodoro time (minutes)')
            .addText(text => text
                .setValue(this.pomo.toString())
                .onChange(value => {
                    this.pomo = Number(value);
                }));

        new Setting(contentEl)
            .setName('Break time (minutes)')
            .addText(text => text
                .setValue(this.break.toString())
                .onChange(value => {
                    this.break = Number(value);
                }));

        new Setting(contentEl)
            .setName('Log to note')
            .addToggle(toggle => toggle
                .setValue(this.logToNote)
                .onChange(value => {
                    this.logToNote = value;
                    this.onOpen();
                }));

        if (this.logToNote) {
            new Setting(contentEl)
                .setName('Log note')
                .addText(text => text
                    .setValue(this.logNote)
                    .onChange(value => {
                        this.logNote = value;
                    }));
        }

        new Setting(contentEl)
            .addButton(button => button
                .setButtonText('Start')
                .setCta()
                .onClick(() => {
                    this.onSubmit(this.pomo, this.break, this.logToNote, this.logNote);
                    this.close();
                }));
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
