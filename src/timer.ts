import { Notice, moment, TFolder, TFile, Modal, ButtonComponent } from 'obsidian';
import { notificationUrl, whiteNoiseUrl } from './audio_urls';
import { WhiteNoise } from './white_noise';
import PomoTimerPlugin from './main';

const electron = require("electron");

const MILLISECS_IN_MINUTE = 60 * 1000;

export const enum Mode {
	Pomo,
	ShortBreak,
	LongBreak,
	NoTimer
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
			return ""; //fixes TypeError: failed to execute 'appendChild' on 'Node https://github.com/kzhovn/statusbar-pomo-obsidian/issues/4
		}
	}

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
                    await this.updateDailySummary();
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

            // choice === 'next' → log and advance
            if (this.mode === Mode.Pomo) {
                this.pomosSinceStart += 1;
                if (this.plugin.settings.logging === true) {
                    await this.logPomo();
                    await this.updateDailySummary();
                }
                const nextMode = (this.pomosSinceStart % this.plugin.settings.longBreakInterval === 0) ? Mode.LongBreak : Mode.ShortBreak;
                this.inOvertime = false;
                this.startTimerNoConfirm(nextMode);
                return;
            } else {
                this.cyclesSinceLastAutoStop += 1;
                if (this.plugin.settings.logging === true) {
                    await this.logBreak();
                    await this.updateDailySummary();
                }
                this.inOvertime = false;
                this.startTimerNoConfirm(Mode.Pomo);
                return;
            }
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
                await this.updateDailySummary();
            }
        } else if (this.mode === Mode.ShortBreak || this.mode === Mode.LongBreak) {
            this.cyclesSinceLastAutoStop += 1;
            if (this.plugin.settings.logging === true) {
                await this.logBreak();
                await this.updateDailySummary();
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
                if (this.mode === Mode.Pomo) {
                    await this.logPomo();
                    await this.updateDailySummary();
                } else if (this.mode === Mode.ShortBreak || this.mode === Mode.LongBreak) {
                    await this.logBreak();
                    await this.updateDailySummary();
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
			await this.updateDailySummary();
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
		this.startTimerWithConfirm(mode);
	}

	private startTimerNoConfirm(mode: Mode = null): void {
		this.setupTimer(mode);
		this.paused = false;

		this.setLogFile();
		if (this.plugin.settings.logging === true) {
			if (this.mode === Mode.Pomo) {
				this.logPomoStart();
			} else if (this.mode === Mode.ShortBreak || this.mode === Mode.LongBreak) {
				this.logBreakStart();
			}
			this.updateDailySummary();
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
				if (this.mode === Mode.Pomo) {
					await this.logPomo();
				} else if (this.mode === Mode.ShortBreak || this.mode === Mode.LongBreak) {
					await this.logBreak();
				}
				await this.updateDailySummary();
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
            if (this.mode === Mode.Pomo) {
                await this.logPomo();
            } else if (this.mode === Mode.ShortBreak || this.mode === Mode.LongBreak) {
                await this.logBreak();
            }
            await this.updateDailySummary();
        }
        this.inOvertime = false;

        // Proceed with normal start
        this.setupTimer(mode);
        this.paused = false; //do I need this?


		// Capture the active note at start so it can be logged later
		this.setLogFile();

		// Log immediately when a session starts
		if (this.plugin.settings.logging === true) {
			if (this.mode === Mode.Pomo) {
				this.logPomoStart();
			} else if (this.mode === Mode.ShortBreak || this.mode === Mode.LongBreak) {
				this.logBreakStart();
			}
			this.updateDailySummary();
		}

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

		// When entering a new session, record the session start time
		if (this.mode === Mode.Pomo) {
			this.pomoSessionStartTime = moment();
			this.breakSessionStartTime = null;
		} else if (this.mode === Mode.ShortBreak || this.mode === Mode.LongBreak) {
			this.breakSessionStartTime = moment();
			this.pomoSessionStartTime = null;
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
				new Notice(`Starting ${time} ${unit} pomodoro.`);
				break;
			}
			case (Mode.ShortBreak):
			case (Mode.LongBreak): {
				new Notice(`Starting ${time} ${unit} break.`);
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

	private async writeLogEntry(logText: string): Promise<void> {
		const filePath = await this.getOrCreateLogFilePath();
		await this.insertUnderDailyHeading(filePath, logText);
	}

	async logPomo(): Promise<void> {
		let durationMs = this.getElapsedActiveMs();
		let prefix = "[🍅]";
		if (moment().isBefore(this.endTime)) {
			prefix = "[🍅 Quit Early]";
		} else if (moment().isAfter(this.endTime)) {
			prefix = "[🍅 Overtime]";
		}
		const startRef = this.pomoSessionStartTime || this.startTime;
		const logText = this.buildLogText(prefix, durationMs, startRef);
		await this.writeLogEntry(logText);
		this.pomoSessionStartTime = null;
	}

	async logPomoStart(): Promise<void> {
		const logText = this.buildLogText("[🍅 Start]");
		await this.writeLogEntry(logText);
	}

	async logPomoQuitEarly(): Promise<void> {
		let baseStart = this.pomoSessionStartTime || this.startTime;
		let durationMs = baseStart ? moment().diff(baseStart) : undefined;
		const logText = this.buildLogText("[🍅 Quit Early]", durationMs, baseStart);
		await this.writeLogEntry(logText);
		this.pomoSessionStartTime = null;
	}

	async logBreakStart(): Promise<void> {
		const logText = this.buildLogText("[🏖 Start]");
		await this.writeLogEntry(logText);
	}

	async logBreak(): Promise<void> {
		let durationMs = this.getElapsedActiveMs();
		let prefix = "[🏖]";
		if (moment().isBefore(this.endTime)) {
			prefix = "[🏖 Quit Early]";
		} else if (moment().isAfter(this.endTime)) {
			prefix = "[🏖 Overtime]";
		}
		const startRef = this.breakSessionStartTime || this.startTime;
		const logText = this.buildLogText(prefix, durationMs, startRef);
		await this.writeLogEntry(logText);
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

	//from Note Refactor plugin by James Lynch, https://github.com/lynchjames/note-refactor-obsidian/blob/80c1a23a1352b5d22c70f1b1d915b4e0a1b2b33f/src/obsidian-file.ts#L69
	async appendFile(filePath: string, logText: string): Promise<void> {
		let existingContent = await this.plugin.app.vault.adapter.read(filePath);
		if (existingContent.length > 0) {
			existingContent = existingContent + '\r';
		}
		await this.plugin.app.vault.adapter.write(filePath, existingContent + logText);
	}

	private async getOrCreateLogFilePath(): Promise<string> {
		if (this.plugin.settings.logToDaily === true) {
			return (await this.plugin.getDailyNoteFile()).path;
		}

		let file = this.plugin.app.vault.getAbstractFileByPath(this.plugin.settings.logFile);
		if (!file || file !instanceof TFolder) { // if no file, create
			console.log("Creating pomodoro log file");
			await this.plugin.app.vault.create(this.plugin.settings.logFile, "");
		}
		return this.plugin.settings.logFile;
	}

	private getTodayHeadingPrefix(): string {
		// One heading per day, include weekday name, totals appended later
		const todayStr = moment().format('YYYY-MM-DD (dddd)');
		return `## Pomodoro ${todayStr}`;
	}

	private buildHeadingWithTotals(pomoMs: number, breakMs: number): string {
		const totalMs = pomoMs + breakMs;
		return `${this.getTodayHeadingPrefix()} — 🍅 ${this.formatTotal(pomoMs)}, 🏖 ${this.formatTotal(breakMs)}, Σ ${this.formatTotal(totalMs)}`;
	}

	private findSectionBounds(lines: string[], headingPrefix: string): { start: number, end: number } | null {
		let start = -1;
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].startsWith(headingPrefix)) {
				start = i;
				break;
			}
		}
		if (start === -1) return null;
		let end = lines.length;
		for (let i = start + 1; i < lines.length; i++) {
			if (lines[i].startsWith('## ') || lines[i].startsWith('# ')) {
				end = i;
				break;
			}
		}
		return { start, end };
	}

	private async insertUnderDailyHeading(filePath: string, logText: string): Promise<void> {
		let content = await this.plugin.app.vault.adapter.read(filePath);
		const headingPrefix = this.getTodayHeadingPrefix();
		let lines = content.split(/\r?\n/);

		let section = this.findSectionBounds(lines, headingPrefix);
		if (!section) {
			// Create new heading at end
			const pomoMs = 0;
			const breakMs = 0;
			const headingLine = this.buildHeadingWithTotals(pomoMs, breakMs);
			if (content.length > 0 && !content.endsWith('\n')) content += '\n';
			content += headingLine + '\n';
			content += logText + '\n';
			await this.plugin.app.vault.adapter.write(filePath, content);
			return;
		}

		// Insert logText at the end of the section
		const insertIndex = section.end; // before next heading or at EOF
		const needsNewlineBefore = insertIndex > 0 && lines[insertIndex - 1].length > 0;
		if (needsNewlineBefore) {
			lines.splice(insertIndex, 0, '');
			section.end++;
		}
		lines.splice(section.end, 0, logText);

		await this.plugin.app.vault.adapter.write(filePath, lines.join('\n'));
	}

	setLogFile(){
		const activeView = this.plugin.app.workspace.getActiveFile();
		if (activeView) {
			this.activeNote = activeView;
		}
	}

	/**************  Daily Summary (daily notes) **************/
	private parseDurationToMillis(duration: string): number {
		// duration formats: HH:mm:ss or mm:ss
		const parts = duration.split(":").map(p => Number(p));
		if (parts.length === 3) {
			return ((parts[0] * 60 * 60) + (parts[1] * 60) + parts[2]) * 1000;
		} else if (parts.length === 2) {
			return ((parts[0] * 60) + parts[1]) * 1000;
		}
		return 0;
	}

    private sumDurations(content: string, type: 'pomo' | 'break'): number {
		const lines = content.split(/\r?\n/);
		let sum = 0;
		for (const line of lines) {
			const trimmed = line.trim();
			let isMatch = false;
            if (type === 'pomo') {
                // Include all finished pomo logs (normal, quit early, overtime), exclude starts
                isMatch = trimmed.startsWith('[🍅') && !trimmed.includes('Start');
            } else {
                // Include all finished break logs, exclude starts
                isMatch = trimmed.startsWith('[🏖') && !trimmed.includes('Start');
            }
			if (!isMatch) continue;

			const m = trimmed.match(/—\s+([0-9]{1,2}:\d{2}(?::\d{2})?)/);
			if (m && m[1]) {
				sum += this.parseDurationToMillis(m[1]);
			}
		}
		return sum;
	}

	private formatTotal(ms: number): string {
		return millisecsToString(ms);
	}

	private async updateDailySummary(): Promise<void> {
		if (this.plugin.settings.logging !== true) return;

		const filePath = await this.getOrCreateLogFilePath();
		let content = await this.plugin.app.vault.adapter.read(filePath);
		let lines = content.split(/\r?\n/);

		const headingPrefix = this.getTodayHeadingPrefix();
		let section = this.findSectionBounds(lines, headingPrefix);
		if (!section) {
			// Nothing to update if today's heading doesn't exist yet
			return;
		}

		// Compute totals within the section (excluding the heading line)
		const sectionLines = lines.slice(section.start + 1, section.end);
		const sectionContent = sectionLines.join('\n');
		const pomoMs = this.sumDurations(sectionContent, 'pomo');
		const breakMs = this.sumDurations(sectionContent, 'break');

		lines[section.start] = this.buildHeadingWithTotals(pomoMs, breakMs);
		await this.plugin.app.vault.adapter.write(filePath, lines.join('\n'));
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

type EndChoice = 'continue' | 'next' | 'quit';

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
