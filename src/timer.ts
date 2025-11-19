import { App, Notice, Modal, ButtonComponent, TFile, moment, TFolder } from 'obsidian';
import { UnsuccessfulPomoModal } from './unsuccessful-pomo-modal';
import { notificationUrl, whiteNoiseUrl } from './audio_urls';
import { WhiteNoise } from './white_noise';
import PomoTimerPlugin from './main';
import { CustomSessionModal } from './custom_session_modal';

const electron = require("electron");

const MILLISECS_IN_MINUTE = 60 * 1000;

export const enum Mode {
	Pomo,
	ShortBreak,
	LongBreak,
	NoTimer,
	Custom
}


export class Timer {
	plugin: PomoTimerPlugin;
	startTime: moment.Moment; /*when currently running timer started*/
	endTime: moment.Moment;   /*when currently running timer will end if not paused*/
	mode: Mode;
	pausedTime: number;  /*time left on paused timer, in milliseconds*/
	paused: boolean;
	autoPaused: boolean;
	pomosSinceStart: number;
	cyclesSinceLastAutoStop: number;
	activeNote: TFile;
	whiteNoisePlayer: WhiteNoise;
	/** Start time of the current pomodoro session across pauses */
	pomoSessionStartTime: moment.Moment | null;
	/** Start time of the current break session across pauses */
	breakSessionStartTime: moment.Moment | null;
	/** When true, keep running past end and show overtime */
	inOvertime: boolean;
	/** Guard to avoid multiple prompts and repeated end handling */
	awaitingEndDecision: boolean;
	customPomo: number;
	customBreak: number;
	isCustom: boolean;

	constructor(plugin: PomoTimerPlugin) {
		this.plugin = plugin;
		this.mode = Mode.NoTimer;
		this.paused = false;
		this.pomosSinceStart = 0;
		this.cyclesSinceLastAutoStop = 0;

			if (this.plugin.settings.whiteNoise === true) {
				this.whiteNoisePlayer = new WhiteNoise(plugin, whiteNoiseUrl);
			}

			this.pomoSessionStartTime = null;
			this.breakSessionStartTime = null;
			this.inOvertime = false;
			this.awaitingEndDecision = false;
			this.customPomo = this.plugin.settings.customPomo;
			this.customBreak = this.plugin.settings.customBreak;
			this.isCustom = false;
		}

	onRibbonIconClick() {
		if (this.mode === Mode.NoTimer) {  //if starting from not having a timer running/paused
			this.startTimer(Mode.Pomo);
		} else { //if timer exists, pause or unpause
			this.togglePause();
		}
	}

	/*Set status bar to remaining time or empty string if no timer is running*/
	//handling switching logic here, should spin out
	async setStatusBarText(): Promise<string> {
		if (this.mode !== Mode.NoTimer) {
			let timer_type_symbol = "";
			if (this.plugin.settings.emoji === true) {
				timer_type_symbol = "🏖️ ";
				if (this.mode === Mode.Pomo) {
					timer_type_symbol = "🍅 ";
				}
				if (this.mode === Mode.Custom) {
					timer_type_symbol = "CUSTOM ";
				}
			}

			if (this.paused === true) {
				const prefix = this.inOvertime ? "+ " : "";
				return timer_type_symbol + prefix + millisecsToString(this.pausedTime); //just show the paused time
			} else if (moment().isSameOrAfter(this.endTime)) {
				if (this.inOvertime) {
					const overtime = moment().diff(this.endTime);
					return timer_type_symbol + "+ " + millisecsToString(overtime);
				}
				if (this.awaitingEndDecision) {
					return timer_type_symbol + millisecsToString(0);
				}
				await this.handleTimerEnd();
			}

			return timer_type_symbol + millisecsToString(this.getCountdown()); //return display value
		               } else {
		                       return `🍅`;
		               }	}

async handleTimerEnd() {
        // Play end notifications once
        if (this.plugin.settings.notificationSound === true) {
            playNotification();
        }
        if (this.plugin.settings.useSystemNotification === true) {
            showSystemNotification(this.mode, this.plugin.settings.emoji);
        }

        // If end-of-session prompt is enabled, ask user to continue or start next
        if (this.plugin.settings.confirmOnSessionEnd) {
            if (this.awaitingEndDecision) return; // guard re-entry
            this.awaitingEndDecision = true;

            const choice = await this.promptEndOfSession();
            this.awaitingEndDecision = false;

            if (choice === 'continue') {
                this.inOvertime = true;
                return; // keep running current session
            }

            if (choice === 'quit') {
                // Log finished session then cleanly stop timer
                if (this.plugin.settings.logging === true) {
                    if (this.mode === Mode.Pomo) {
                        await this.logPomo();
                    } else if (this.mode === Mode.ShortBreak || this.mode === Mode.LongBreak) {
                        await this.logBreak();
                    }
                }
                // Stop any white noise
                if (this.plugin.settings.whiteNoise === true && this.whiteNoisePlayer) {
                    this.whiteNoisePlayer.stopWhiteNoise();
                }
                // Reset state similar to quitTimer but without double logging
                this.mode = Mode.NoTimer;
                this.startTime = moment(0);
                this.endTime = moment(0);
                this.paused = false;
                this.inOvertime = false;
                this.autoPaused = false;
                this.pausedTime = 0;
                this.pomosSinceStart = 0;
                return;
            }

            if (choice === 'unsuccessful') {
                new UnsuccessfulPomoModal(this.plugin.app, async (reason: string) => {
                    await this.logUnsuccessfulPomo(reason);
                    const nextMode = (this.pomosSinceStart % this.plugin.settings.longBreakInterval === 0) ? Mode.LongBreak : Mode.ShortBreak;
                    this.inOvertime = false;
                    this.startTimerNoConfirm(nextMode);
                }).open();
                return;
            }

            // choice === 'next' → log and advance
            if (this.mode === Mode.Pomo) {
                this.pomosSinceStart += 1;
                if (this.plugin.settings.logging === true) {
                    await this.logPomo(this.getElapsedActiveMs());
                }
                const nextMode = (this.pomosSinceStart % this.plugin.settings.longBreakInterval === 0) ? Mode.LongBreak : Mode.ShortBreak;
                this.inOvertime = false;
                this.startTimerNoConfirm(nextMode);
                return;
            } else {
                this.cyclesSinceLastAutoStop += 1;
                if (this.plugin.settings.logging === true) {
                    await this.logBreak(this.getElapsedActiveMs());
                }
                this.inOvertime = false;
                this.startTimerNoConfirm(Mode.Pomo);
                return;
            }
        }

		if (this.mode === Mode.Custom) {
			this.plugin.settings.customTimer = true;
			this.plugin.settings.customPomo = this.customPomo;
			this.plugin.settings.customBreak = this.customBreak;
			this.plugin.saveSettings();
			this.startTimer(Mode.Custom);
			return;
		}

        // Fallback to prior behavior when prompt is disabled
        if (this.plugin.settings.manualAdvance) {
            this.inOvertime = true;
            return;
        }

        if (this.mode === Mode.Pomo) { //completed another pomo
            this.pomosSinceStart += 1;
            if (this.plugin.settings.logging === true) {
                await this.logPomo();
            }
        } else if (this.mode === Mode.ShortBreak || this.mode === Mode.LongBreak) {
            this.cyclesSinceLastAutoStop += 1;
            if (this.plugin.settings.logging === true) {
                await this.logBreak();
            }
        }

        if (this.plugin.settings.autostartTimer === false && this.plugin.settings.numAutoCycles <= this.cyclesSinceLastAutoStop) {
            this.setupTimer();
            this.autoPaused = true;
            this.paused = true;
            this.pausedTime = this.getTotalModeMillisecs();
            this.cyclesSinceLastAutoStop = 0;
        } else {
            this.startTimerNoConfirm();
        }
    }

    async quitTimer(): Promise<void> {
        // Log the running session on quit with actual duration
        if (this.plugin.settings.logging === true) {
            try {
				const elapsedMs = this.getElapsedActiveMs();
                if (this.mode === Mode.Pomo) {
                    await this.logPomo(elapsedMs);
                } else if (this.mode === Mode.ShortBreak || this.mode === Mode.LongBreak) {
                    await this.logBreak(elapsedMs);
                }
            } catch (e) {
                console.log(e);
            }
        }

		this.mode = Mode.NoTimer;
		this.startTime = moment(0);
		this.endTime = moment(0);
		this.paused = false;
        this.pomosSinceStart = 0;
        this.inOvertime = false;
		this.isCustom = false;

		if (this.plugin.settings.whiteNoise === true) {
			this.whiteNoisePlayer.stopWhiteNoise();
		}

		await this.plugin.loadSettings(); //why am I loading settings on quit? to ensure that when I restart everything is correct? seems weird
	}

	pauseTimer(): void {
		this.paused = true;
		if (this.inOvertime) {
			this.pausedTime = moment().diff(this.endTime);
		} else {
			this.pausedTime = this.getCountdown();
		}

		if (this.plugin.settings.whiteNoise === true) {
			this.whiteNoisePlayer.stopWhiteNoise();
		}
	}

	async togglePause() {
		if (this.paused === true) {
			this.restartTimer();
		} else if (this.mode !== Mode.NoTimer) { //if some timer running
			this.pauseTimer();
			new Notice("Timer paused.")
		}

		// Update summary on any state change
		if (this.plugin.settings.logging === true) {
		}
	}

	restartTimer(): void {
		if (this.plugin.settings.logActiveNote === true && this.autoPaused === true) {
			this.setLogFile();
			this.autoPaused = false;
		}

		if (!this.inOvertime) {
			this.setStartAndEndTime(this.pausedTime);
		}
		this.modeRestartingNotification();
		this.paused = false;

		if (this.plugin.settings.whiteNoise === true) {
			this.whiteNoisePlayer.whiteNoise();
		}
	}

	startTimer(mode: Mode = null): void {
		if (mode === Mode.Custom) {
			new CustomSessionModal(this.plugin.app, this.plugin, (pomo: number, shortBreak: number, logToNote: boolean, logNote: string) => {
				this.customPomo = pomo;
				this.customBreak = shortBreak;
				this.plugin.settings.logToNote = logToNote;
				this.plugin.settings.logNote = logNote;
				this.plugin.saveSettings();
				this.isCustom = true;
				this.startTimerWithConfirm(Mode.Pomo);
			}).open();
			return;
		}
		this.isCustom = false;
		this.startTimerWithConfirm(mode);
	}

	private startTimerNoConfirm(mode: Mode = null): void {
		this.setupTimer(mode);
		this.paused = false;

		this.setLogFile();
		if (this.plugin.settings.logging === true) {
			if (this.mode === Mode.Pomo) {
				this.pomoSessionStartTime = moment();
			} else if (this.mode === Mode.ShortBreak || this.mode === Mode.LongBreak) {
				this.breakSessionStartTime = moment();
			}
		}

		this.modeStartingNotification();
		if (this.plugin.settings.whiteNoise === true) {
			this.whiteNoisePlayer.whiteNoise();
		}
	}

	async finishAndStartNext(): Promise<void> {
		if (this.mode === Mode.NoTimer) {
			new Notice('No active session to finish.');
			return;
		}

		try {
			if (this.plugin.settings.logging === true) {
				const elapsedMs = this.getElapsedActiveMs();
				if (this.mode === Mode.Pomo) {
					await this.logPomo(elapsedMs);
				} else if (this.mode === Mode.ShortBreak || this.mode === Mode.LongBreak) {
					await this.logBreak(elapsedMs);
				}
			}
		} catch (e) {
			console.log(e);
		}

		let nextMode: Mode;
		if (this.mode === Mode.Pomo) {
			this.pomosSinceStart += 1;
			nextMode = (this.pomosSinceStart % this.plugin.settings.longBreakInterval === 0) ? Mode.LongBreak : Mode.ShortBreak;
		} else { // ShortBreak or LongBreak
			this.cyclesSinceLastAutoStop += 1;
			nextMode = Mode.Pomo;
		}

		this.inOvertime = false;
		this.startTimerNoConfirm(nextMode);
	}

    private async startTimerWithConfirm(mode: Mode = null): Promise<void> {
		// Compute what the next mode would be without mutating state yet
		let nextMode: Mode;
		if (mode !== null) {
			nextMode = mode;
		} else {
			if (this.mode === Mode.Pomo) {
				nextMode = (this.pomosSinceStart % this.plugin.settings.longBreakInterval === 0) ? Mode.LongBreak : Mode.ShortBreak;
			} else {
				nextMode = Mode.Pomo;
			}
		}

		const proceed = await this.confirmSessionStart(nextMode);
        if (!proceed) {
            // Do nothing: keep current session running (or idle)
            return;
        }

        // Close out any existing session (normal, paused, or overtime) before starting the new one
        if (this.plugin.settings.logging === true && this.mode !== Mode.NoTimer && nextMode !== this.mode) {
			const elapsedMs = this.getElapsedActiveMs();
            if (this.mode === Mode.Pomo) {
                await this.logPomo(elapsedMs);
            } else if (this.mode === Mode.ShortBreak || this.mode === Mode.LongBreak) {
                await this.logBreak(elapsedMs);
            }
        }
        this.inOvertime = false;

        // Proceed with normal start
        this.setupTimer(mode);
        this.paused = false; //do I need this?


		// Capture the active note at start so it can be logged later
		this.setLogFile();

		this.modeStartingNotification();

		if (this.plugin.settings.whiteNoise === true) {
			this.whiteNoisePlayer.whiteNoise();
		}
	}

	private confirmSessionStart(nextMode: Mode): Promise<boolean> {
		if (this.plugin.settings.confirmOnSessionStart !== true) return Promise.resolve(true);

		return new Promise<boolean>((resolve) => {
			const modal = new ConfirmStartModal(this.plugin, nextMode, (ok) => {
				resolve(ok);
			});
			modal.open();
		});
	}

	private promptEndOfSession(): Promise<EndChoice> {
		let nextMode: Mode = this.mode === Mode.Pomo
			? ((this.pomosSinceStart % this.plugin.settings.longBreakInterval === 0) ? Mode.LongBreak : Mode.ShortBreak)
			: Mode.Pomo;
		return new Promise<EndChoice>((resolve) => {
			const modal = new EndOfSessionModal(this.plugin, nextMode, (choice) => {
				resolve(choice);
			});
			modal.open();
		});
	}

	private setupTimer(mode: Mode = null) {
		if (mode === null) { //no arg -> start next mode in cycle
			if (this.mode === Mode.Pomo) {
				if (this.pomosSinceStart % this.plugin.settings.longBreakInterval === 0) {
					this.mode = Mode.LongBreak;
				} else {
					this.mode = Mode.ShortBreak;
				}
			} else { //short break, long break, or no timer
				this.mode = Mode.Pomo;
			}
		} else { //starting a specific mode passed to func
			this.mode = mode;
		}
		this.inOvertime = false;
		this.setStartAndEndTime(this.getTotalModeMillisecs());
	}

	setStartAndEndTime(millisecsLeft: number): void {
		this.startTime = moment(); //start time to current time
		this.endTime = moment().add(millisecsLeft, 'milliseconds');
	}

	/*Return milliseconds left until end of timer*/
	getCountdown(): number {
		let endTimeClone = this.endTime.clone(); //rewrite with freeze?
		return endTimeClone.diff(moment());
	}

	getTotalModeMillisecs(): number {
		if (this.isCustom) {
			switch (this.mode) {
				case Mode.Pomo: {
					return this.customPomo * MILLISECS_IN_MINUTE;
				}
				case Mode.ShortBreak:
				case Mode.LongBreak: {
					return this.customBreak * MILLISECS_IN_MINUTE;
				}
			}
		}

		switch (this.mode) {
			case Mode.Pomo: {
				return this.plugin.settings.pomo * MILLISECS_IN_MINUTE;
			}
			case Mode.ShortBreak: {
				return this.plugin.settings.shortBreak * MILLISECS_IN_MINUTE;
			}
			case Mode.LongBreak: {
				return this.plugin.settings.longBreak * MILLISECS_IN_MINUTE;
			}
			case Mode.NoTimer: {
				throw new Error("Mode NoTimer does not have an associated time value");
			}
		}
	}



	/**************  Notifications  **************/
	/*Sends notification corresponding to whatever the mode is at the moment it's called*/
	modeStartingNotification(): void {
		let time = this.getTotalModeMillisecs();
		let unit: string;

		if (time >= MILLISECS_IN_MINUTE) { /*display in minutes*/
			time = Math.floor(time / MILLISECS_IN_MINUTE);
			unit = 'minute';
		} else { /*less than a minute, display in seconds*/
			time = Math.floor(time / 1000); //convert to secs
			unit = 'second';
		}

		switch (this.mode) {
			case (Mode.Pomo): {
				if (this.isCustom) {
					new Notice(`Starting ${time} ${unit} custom pomodoro.`);
				} else {
					new Notice(`Starting ${time} ${unit} pomodoro.`);
				}
				break;
			}
			case (Mode.ShortBreak):
			case (Mode.LongBreak): {
				if (this.isCustom) {
					new Notice(`Starting ${time} ${unit} custom break.`);
				} else {
					new Notice(`Starting ${time} ${unit} break.`);
				}
				break;
			}
			case (Mode.NoTimer): {
				new Notice('Quitting pomodoro timer.');
				break;
			}
		}
	}

	modeRestartingNotification(): void {
		switch (this.mode) {
			case (Mode.Pomo): {
				new Notice(`Restarting pomodoro.`);
				break;
			}
			case (Mode.ShortBreak):
			case (Mode.LongBreak): {
				new Notice(`Restarting break.`);
				break;
			}
		}
	}



	/**************  Logging  **************/
private buildLogText(prefix: string = "", durationMs?: number, start?: moment.Moment): string {
    // Log time of day with seconds for clearer differences within a minute
    const endTs = moment().format('HH:mm:ss');
    let timePart = endTs;
    if (start) {
        const startTs = start.format('HH:mm:ss');
        timePart = `${startTs}–${endTs}`;
    }
    let logText = prefix ? `${prefix} ${timePart}` : timePart;

		// Append duration before the note link when provided
		if (typeof durationMs === 'number' && !isNaN(durationMs) && durationMs >= 0) {
			logText = `${logText} — ${millisecsToString(durationMs)}`;
		}

		// Always place the active note link at the end when enabled
		if (this.plugin.settings.logActiveNote === true && this.activeNote) {
			const linkText = this.plugin.app.fileManager.generateMarkdownLink(this.activeNote, '');
			logText = `${logText} ${linkText}`;
			logText = logText.replace(String.raw`\n`, "\n");
		}

		return logText;
	}

	private async writeLogEntry(logText: string, duration?: number, mode?: Mode): Promise<void> {
		const filePath = await this.getOrCreateLogFilePath();
		let content = await this.plugin.app.vault.adapter.read(filePath);
		content = logText + '\n' + content;
		content = await this.updateLogSummary(content, duration, mode);
		await this.plugin.app.vault.adapter.write(filePath, content);
	}

	private async updateLogSummary(content: string, duration: number, mode: Mode): Promise<string> {
		const summaryRegex = /---\n\*\*Total Session Time:\*\* (.*)\n\*\*Total Break Time:\*\* (.*)\n\*\*Total Time:\*\* (.*)\n---\n/;
		const match = content.match(summaryRegex);

		let sessionTime = 0;
		let breakTime = 0;

		if (match) {
			sessionTime = moment.duration(match[1]).asMilliseconds();
			breakTime = moment.duration(match[2]).asMilliseconds();
			content = content.replace(summaryRegex, '');
		}

		if (mode === Mode.Pomo) {
			sessionTime += duration;
		} else if (mode === Mode.ShortBreak || mode === Mode.LongBreak) {
			breakTime += duration;
		}

		               const totalTime = sessionTime + breakTime;
		
		               const summary = `---
		**Total Session Time:** ${moment.utc(sessionTime).format('HH:mm:ss')}
		**Total Break Time:** ${moment.utc(breakTime).format('HH:mm:ss')}
		**Total Time:** ${moment.utc(totalTime).format('HH:mm:ss')}
		---
		`;
		
		               return summary + content;	}

	async logPomo(durationMs?: number): Promise<void> {
		const duration = durationMs ?? this.getTotalModeMillisecs();
		const startTime = this.pomoSessionStartTime ?? moment();
		const logText = `[🍅] ${startTime.format('YYYY-MM-DD HH:mm')} - ${moment().format('HH:mm')} (${millisecsToString(duration)} minutes)`;
		await this.writeLogEntry(logText, duration, Mode.Pomo);
		this.pomoSessionStartTime = null;
	}

	async logUnsuccessfulPomo(reason: string): Promise<void> {
		const now = moment();
		const logText = `[🍅] ${now.format('YYYY-MM-DD HH:mm')} - Unsuccessful. Reason: ${reason}`;
		const filePath = await this.getOrCreateLogFilePath(true);
		let content = await this.plugin.app.vault.adapter.read(filePath);
		content = logText + '\n' + content;
		await this.plugin.app.vault.adapter.write(filePath, content);
	}

	async logBreak(durationMs?: number): Promise<void> {
		const duration = durationMs ?? this.getTotalModeMillisecs();
		const startTime = this.breakSessionStartTime ?? moment();
		const logText = `[🏖] ${startTime.format('YYYY-MM-DD HH:mm')} - ${moment().format('HH:mm')} (${millisecsToString(duration)} minutes)`;
		await this.writeLogEntry(logText, duration, this.mode);
		this.breakSessionStartTime = null;
	}

	private getElapsedActiveMs(): number {
		const total = this.getTotalModeMillisecs();
		const now = moment();

		if (this.paused === true) {
			// When paused:
			// - In normal time, pausedTime stores remaining time
			// - In overtime, pausedTime stores overtime elapsed
			if (this.inOvertime || (this.endTime && now.isAfter(this.endTime))) {
				return total + Math.max(0, this.pausedTime);
			} else {
				return Math.max(0, total - Math.max(0, this.pausedTime));
			}
		}

		if (this.endTime) {
			const diff = this.endTime.clone().diff(now); // positive if time remains, negative if overtime
			if (diff >= 0) {
				return Math.max(0, total - diff);
			} else {
				return total + Math.abs(diff);
			}
		}

		return 0;
	}

	async appendFile(filePath: string, logText: string): Promise<void> {
		let existingContent = await this.plugin.app.vault.adapter.read(filePath);
		if (existingContent.length > 0) {
			existingContent = existingContent + '\r';
		}
		await this.plugin.app.vault.adapter.write(filePath, existingContent + logText);
	}

	private async getOrCreateLogFilePath(unsuccessful: boolean = false): Promise<string> {
		if (unsuccessful) {
			const filePath = this.plugin.settings.failedPomoLogFile;
			let file = this.plugin.app.vault.getAbstractFileByPath(filePath);
			if (!file || file !instanceof TFolder) { // if no file, create
				console.log("Creating pomodoro log file");
				await this.plugin.app.vault.create(filePath, "");
			}
			return filePath;
		}
		
		if (this.plugin.settings.logToNote) {
			let file = this.plugin.app.vault.getAbstractFileByPath(this.plugin.settings.logNote);
			if (!file || file !instanceof TFolder) { // if no file, create
				console.log("Creating pomodoro log file");
				await this.plugin.app.vault.create(this.plugin.settings.logNote, "");
			}
			return this.plugin.settings.logNote;
		}

		let file = this.plugin.app.vault.getAbstractFileByPath(this.plugin.settings.logFile);
		if (!file || file !instanceof TFolder) { // if no file, create
			console.log("Creating pomodoro log file");
			await this.plugin.app.vault.create(this.plugin.settings.logFile, "");
		}
		return this.plugin.settings.logFile;
	}

	setLogFile(){
		const activeView = this.plugin.app.workspace.getActiveFile();
		if (activeView) {
			this.activeNote = activeView;
		}
	}
}

class ConfirmStartModal extends Modal {
	private onCloseCb: (ok: boolean) => void;
	private nextMode: Mode;
	private plugin: PomoTimerPlugin;

	constructor(plugin: PomoTimerPlugin, nextMode: Mode, onCloseCb: (ok: boolean) => void) {
		super(plugin.app);
		this.plugin = plugin;
		this.nextMode = nextMode;
		this.onCloseCb = onCloseCb;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		const label = this.nextMode === Mode.Pomo ? 'Start pomodoro?' : 'Start break?';
		contentEl.createEl('h3', { text: label });
		const duration = ((): number => {
			switch (this.nextMode) {
				case Mode.Pomo: return this.plugin.settings.pomo;
				case Mode.ShortBreak: return this.plugin.settings.shortBreak;
				case Mode.LongBreak: return this.plugin.settings.longBreak;
			}
			return 0;
		})();
		contentEl.createEl('p', { text: `Duration: ${duration} min` });

		const buttons = contentEl.createDiv({ cls: 'mod-footer' });
		new ButtonComponent(buttons)
			.setButtonText('Cancel')
			.onClick(() => { this.close(); this.onCloseCb(false); });
		new ButtonComponent(buttons)
			.setCta()
			.setButtonText('Start')
			.onClick(() => { this.close(); this.onCloseCb(true); });
	}

	onClose() {
		this.contentEl.empty();
	}
}

type EndChoice = 'continue' | 'next' | 'quit' | 'unsuccessful';

class EndOfSessionModal extends Modal {
	private onCloseCb: (choice: EndChoice) => void;
	private nextMode: Mode;
	private plugin: PomoTimerPlugin;

	constructor(plugin: PomoTimerPlugin, nextMode: Mode, onCloseCb: (choice: EndChoice) => void) {
		super(plugin.app);
		this.plugin = plugin;
		this.nextMode = nextMode;
		this.onCloseCb = onCloseCb;
	}

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        const nextLabel = this.nextMode === Mode.Pomo ? 'Start next pomodoro' : 'Start next break';
        contentEl.createEl('h3', { text: 'Session ended' });
        contentEl.createEl('p', { text: 'Continue current session (overtime) or start the next?' });

        const buttons = contentEl.createDiv({ cls: 'mod-footer' });
        if (this.plugin.timer.mode === Mode.Pomo) {
            new ButtonComponent(buttons)
                .setButtonText('Unsuccessful')
                .onClick(() => { this.close(); this.onCloseCb('unsuccessful'); });
        }
        new ButtonComponent(buttons)
            .setButtonText('Quit')
            .onClick(() => { this.close(); this.onCloseCb('quit'); });
        new ButtonComponent(buttons)
            .setButtonText('Continue')
            .onClick(() => { this.close(); this.onCloseCb('continue'); });
        new ButtonComponent(buttons)
            .setCta()
            .setButtonText(nextLabel)
            .onClick(() => { this.close(); this.onCloseCb('next'); });
    }

	onClose() {
		this.contentEl.empty();
	}
}

/*Returns [HH:]mm:ss left on the current timer*/
function millisecsToString(millisecs: number): string {
	let formattedCountDown: string;

	if (millisecs >= 60 * 60 * 1000) { /* >= 1 hour*/
		formattedCountDown = moment.utc(millisecs).format('HH:mm:ss');
	} else {
		formattedCountDown = moment.utc(millisecs).format('mm:ss');
	}

	return formattedCountDown.toString();
}

function playNotification(): void {
	const audio = new Audio(notificationUrl);
	audio.play();
}

function showSystemNotification(mode:Mode, useEmoji:boolean): void {
	let text = "";
	switch (mode) {
		case (Mode.Pomo): {
			let emoji = useEmoji ? "🏖" : ""
			text = `End of the pomodoro, time to take a break ${emoji}`;
			break;
		}
		case (Mode.ShortBreak):
		case (Mode.LongBreak): {
			let emoji = useEmoji ? "🍅" : ""
			text = `End of the break, time for the next pomodoro ${emoji}`;
			break;
		}
		case (Mode.NoTimer): {
			// no system notification needed
			return;
		}
	}
	let emoji = useEmoji ? "🍅" : ""
	let title = `Obsidian Pomodoro ${emoji}`;

	// Show system notification
	const Notification = (electron as any).remote.Notification;
	const n = new Notification({
		title: title,
		body: text,
		silent: true
	});
	n.on("click", () => {
		n.close();
	});
	n.show();
}
