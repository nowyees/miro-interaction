export const CLIPS = Object.freeze({
  IDLE: '1_IDLE_v4.mp4', ONBOARD: '2_On Boarding.mp4', BACK: '3_Back IDLE.mp4',
  RSP: '4_RSP.mp4', HI: '5_HI_v4.mp4', PICTURE: '6_Picture_v4.mp4', TOMATO: '7_Tomato_v4.mp4',
});
export const ACTIONS = new Set(['RSP', 'HI', 'PICTURE', 'TOMATO']);

const ATTENTION_MS = 2000;   // look at the robot this long to wake it
const ABSENCE_MS = 5000;     // no face this long in DEFAULT -> back to idle
const RELEASE_MS = 300;      // gesture must stop briefly before the next one

// IDLE -(look 2s)-> ONBOARD -> DEFAULT -(gesture)-> action -> DEFAULT
// DEFAULT -(no face 5s)-> BACK -> IDLE
export class InteractionFlow {
  constructor(onChange) { this.onChange = onChange; this.reset(0); }
  reset(at) {
    this.lastTick = null; this.attentionStart = null; this.absenceStart = null;
    this.releaseStart = null; this.armed = true;
    this.change('IDLE', at);
  }
  change(state, at) {
    this.state = state; this.since = at; this.attentionStart = null;
    this.onChange?.(state);
  }
  ended(state, at) {
    if (state !== this.state) return;
    if (state === 'ONBOARD' || ACTIONS.has(state)) this.change('DEFAULT', at);
    else if (state === 'BACK') this.change('IDLE', at);
  }
  // Manual trigger (keyboard fallback for demos).
  trigger(gesture, at) {
    if (this.state === 'DEFAULT' && ACTIONS.has(gesture)) this.change(gesture, at);
  }
  suspend() { this.lastTick = null; this.attentionStart = null; this.absenceStart = null; }
  tick({ present, attentive, gesture, at }) {
    if (this.lastTick !== null && at - this.lastTick > 1000) this.suspend();
    this.lastTick = at;

    if (gesture) this.releaseStart = null;
    else { this.releaseStart ??= at; if (at - this.releaseStart >= RELEASE_MS) this.armed = true; }

    if (this.state === 'IDLE') {
      // A short glance away or a missed frame doesn't restart the count.
      if (attentive) {
        this.attentionStart ??= at; this.lastAttention = at;
        if (at - this.attentionStart >= ATTENTION_MS) this.change('ONBOARD', at);
      } else if (at - (this.lastAttention ?? -Infinity) > 400) this.attentionStart = null;
      return;
    }
    if (this.state !== 'DEFAULT') return;

    if (present) this.absenceStart = null;
    else {
      this.absenceStart ??= at;
      if (at - this.absenceStart >= ABSENCE_MS) { this.change('BACK', at); return; }
    }
    if (gesture && this.armed && at - this.since >= 300) {
      this.armed = false;
      this.change(gesture, at);
    }
  }
}
