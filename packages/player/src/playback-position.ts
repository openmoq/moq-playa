type PositionReader = () => number | null;

interface PositionOwner {
  readonly epoch: object;
  timeMs: number;
  reader: PositionReader | null;
  revision: number;
}

/** Content position supplied by an owned output, without clock extrapolation. */
export class PlaybackPosition {
  private owner: PositionOwner | null = null;
  private playing = false;
  private intentRevision = 0;

  constructor(private readonly canSample: () => boolean = () => true) {}

  /** Use a fresh epoch per admission; the target holds until this seek proves its output. */
  begin(epoch: object, targetMs: number): void {
    if (!Number.isFinite(targetMs) || targetMs < 0) throw new RangeError('Expected a finite nonnegative position');
    this.owner = { epoch, timeMs: targetMs, reader: null, revision: 0 };
  }

  owns(epoch: object): boolean { return this.owner?.epoch === epoch; }

  /** The caller supplies a producing-output witness, never an old sink's movement. */
  activate(epoch: object, reader: PositionReader): boolean {
    const owner = this.owner;
    if (!owner || owner.epoch !== epoch) return false;
    const revision = ++owner.revision;
    let value: number | null;
    try { value = reader(); } catch { return false; }
    if (this.owner !== owner || owner.revision !== revision || !this.valid(value)) return false;
    owner.reader = reader;
    owner.timeMs = value;
    return true;
  }

  /** Null means no seek owns a content position; unavailable output holds its last observation. */
  read(sampleOutput = true): number | null {
    const owner = this.owner;
    if (!owner) return null;
    if (!sampleOutput || !this.playing || owner.reader === null) return owner.timeMs;
    const revision = ++owner.revision;
    let value: number | null = null;
    let permitted = false;
    try {
      if (!this.canSample() || this.owner !== owner || owner.revision !== revision) return this.owner?.timeMs ?? null;
      value = owner.reader();
      permitted = this.canSample();
    } catch { /* An optional clock read cannot replace its owner. */ }
    if (permitted && this.playing && this.owner === owner && owner.revision === revision && this.valid(value)) owner.timeMs = value;
    return this.owner?.timeMs ?? null;
  }

  /** Pause samples the owned output first; a newer reentrant intent wins. */
  setPlaying(playing: boolean): void {
    const revision = ++this.intentRevision;
    if (!playing && this.playing) this.read();
    if (this.intentRevision === revision) this.playing = playing;
  }

  /** A superseded attempt may retire itself without clearing its successor. */
  retire(epoch?: object): void {
    if (epoch === undefined || this.owner?.epoch === epoch) this.owner = null;
  }

  private valid(value: number | null): value is number {
    return value !== null && Number.isFinite(value) && value >= 0;
  }
}
