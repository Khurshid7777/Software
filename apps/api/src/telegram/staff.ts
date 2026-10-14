import type { Notifier, NotifyButton } from "./publisher.js";

export interface StaffTargets {
  /** Group chat id; when set, messages go there instead of personal DMs. */
  chatId?: number;
  /** Fallback recipients (Telegram user ids). */
  userIds: number[];
}

/**
 * Messages to staff: operators (delivery) and moderators (pending listings, complaints).
 * Failures are logged and never break the user-facing request.
 */
export class StaffNotifier {
  constructor(
    private notifier: Notifier | null,
    private targets: { operators: StaffTargets; moderators: StaffTargets; admins?: StaffTargets },
  ) {}

  operators(text: string, buttons: NotifyButton[][] = []) {
    return this.send(this.targets.operators, text, buttons);
  }

  moderators(text: string, buttons: NotifyButton[][] = []) {
    return this.send(this.targets.moderators, text, buttons);
  }

  /** Admins only (daily digest); falls back to the moderators' target when no admin target is set. */
  admins(text: string, buttons: NotifyButton[][] = []) {
    return this.send(this.targets.admins ?? this.targets.moderators, text, buttons);
  }

  private async send(to: StaffTargets, text: string, buttons: NotifyButton[][]) {
    if (!this.notifier) return 0;
    const ids = to.chatId ? [to.chatId] : [...new Set(to.userIds)];
    let sent = 0;
    for (const id of ids) {
      try {
        await this.notifier.send(id, text, buttons);
        sent++;
      } catch (err) {
        console.error("staff notification failed", id, err);
      }
    }
    return sent;
  }
}
