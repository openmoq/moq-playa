import type {
    AlternateSet, CatalogSelection, MediaSelectionSnapshot, MoqtPlayer, ScopeId,
    SelectableTrack, SelectionConfig, TrackIdentity, TrackRefConfig,
} from '@openmoq/player';

export interface TrackMenuElements {
    programControl: HTMLElement;
    programSelect: HTMLSelectElement;
    viewControl: HTMLElement;
    viewSelect: HTMLSelectElement;
    videoTrackDropdown: HTMLElement;
    videoTrackBtn: HTMLButtonElement;
    videoTrackLabel: HTMLElement;
    videoTrackMenu: HTMLElement;
    audioTrackDropdown: HTMLElement;
    audioTrackBtn: HTMLButtonElement;
    audioTrackLabel: HTMLElement;
    audioTrackMenu: HTMLElement;
}

export interface PresentationChoice {
    readonly key: string;
    readonly label: string;
    readonly active: boolean;
    readonly selection: SelectionConfig;
    readonly language?: string;
}

export interface SelectionActions {
    retune(choice: PresentationChoice, choices: readonly PresentationChoice[]): void;
    video(reference: TrackRefConfig): void;
}

export const FRESH_PRESENTATION_LABEL = 'Start selected presentation anew';

function sameTrack(a: TrackIdentity | null, b: TrackIdentity): boolean {
    return a !== null && a.name === b.name && a.namespaceFields.length === b.namespaceFields.length
        && a.namespaceFields.every((field, i) => field === b.namespaceFields[i]);
}
function sameScope(a: ScopeId | null, b: ScopeId): boolean {
    return a !== null && (a.kind === 'render-group' && b.kind === 'render-group'
        ? a.renderGroup === b.renderGroup : a.kind === b.kind);
}
function reference(id: TrackIdentity): TrackRefConfig {
    return { name: id.name, namespace: [...id.namespaceFields] };
}
function scopeSelection(scope: ScopeId): SelectionConfig {
    return { renderGroup: scope.kind === 'render-group' ? scope.renderGroup : null };
}
function viewSelection(set: AlternateSet): SelectionConfig {
    return set.id.kind === 'declared' ? { videoAltGroup: set.id.altGroup }
        : { videoTrack: reference(set.tracks[0]!.id) };
}
function identityKey(id: TrackIdentity): string {
    return JSON.stringify([id.namespaceFields, id.name]);
}
function trackLabel(track: SelectableTrack): string {
    return [track.label ?? track.id.name, track.lang].filter(Boolean).join(' · ');
}

/** Present the public model's scopes and sets; grouping policy belongs to the player. */
export function selectionMenus(model: CatalogSelection | null, selected: MediaSelectionSnapshot) {
    const scopes = model?.scopes ?? [];
    const scope = scopes.find(item => sameScope(selected.scope, item.id));
    const currentSet = scope?.video.find(set => set.tracks.some(track => sameTrack(selected.video, track.id)));
    const adoptedVideo = currentSet?.tracks.find(track => sameTrack(selected.video, track.id));
    const adoptedAudio = scope?.audio.flatMap(set => set.tracks).find(track => sameTrack(selected.audio, track.id));
    const programs: PresentationChoice[] = scopes.map(item => ({
        key: JSON.stringify(['scope', item.id]),
        label: item.id.kind === 'render-group' ? `Render group ${item.id.renderGroup}` : 'Unassigned',
        active: sameScope(selected.scope, item.id), selection: scopeSelection(item.id),
    }));
    const views: PresentationChoice[] = scope?.video.map(set => ({
        key: JSON.stringify(['view', scope.id, set.id.kind === 'declared' ? set.id.altGroup : set.tracks[0]!.id]),
        label: (() => {
            const label = set.tracks[0]?.label ?? (set.id.kind === 'declared' ? `View ${set.id.altGroup}` : set.tracks[0]!.id.name);
            const repeated = scope.video.filter(other => (other.tracks[0]?.label
                ?? (other.id.kind === 'declared' ? `View ${other.id.altGroup}` : other.tracks[0]!.id.name)) === label).length > 1;
            return repeated ? `${label} · ${set.id.kind === 'declared' ? `View ${set.id.altGroup}`
                : JSON.stringify(set.tracks[0]!.id.namespaceFields)}` : label;
        })(),
        active: set === currentSet, selection: { ...scopeSelection(scope.id), ...viewSelection(set) },
    })) ?? [];
    const videos = scope?.video.flatMap(set => set.tracks).filter(track =>
        selected.videoAlternatives.some(id => sameTrack(id, track.id))) ?? [];
    const audioTracks = scope?.audio.flatMap(set => set.tracks).filter(track =>
        selected.audioChoices.some(id => sameTrack(id, track.id))) ?? [];
    const audio: PresentationChoice[] = audioTracks.map(track => ({
        key: identityKey(track.id), label: audioTracks.filter(other => trackLabel(other) === trackLabel(track)).length > 1
            ? `${trackLabel(track)} · ${JSON.stringify(track.id.namespaceFields)}` : trackLabel(track), active: sameTrack(selected.audio, track.id),
        selection: { ...scopeSelection(scope!.id),
            ...(currentSet ? selected.autoQuality ? viewSelection(currentSet)
                : selected.video ? { videoTrack: reference(selected.video) } : {} : {}),
            audioTrack: reference(track.id) },
        ...(track.lang ? { language: track.lang } : {}),
    }));
    return { programs, views, videos, audio, adoptedVideo, adoptedAudio, hasVideo: scope ? scope.video.length > 0 : undefined };
}

/** Update just the legacy video-set link parameter; exact identities stay in memory. */
export function updateSelectionLink(params: URLSearchParams, selection: SelectionConfig): void {
    if (selection.videoAltGroup !== undefined) params.set('altGroup', String(selection.videoAltGroup));
    else params.delete('altGroup');
}

/** The same owner check protects events, delayed catalog rendering, and settled commands. */
export function playbackOwnerIsCurrent<T>(owner: T, epoch: number, current: T | null, currentEpoch: number): boolean {
    return owner === current && epoch === currentEpoch;
}

export function renderTrackMenus(
    p: Pick<MoqtPlayer, 'selection'> | null, elements: TrackMenuElements, model: CatalogSelection | null,
    actions: SelectionActions, disabled = false,
): void {
    const selected = p?.selection ?? { revision: 0, scope: null, video: null, audio: null,
        videoAlternatives: [], audioChoices: [], autoQuality: true };
    const menus = selectionMenus(model, selected);
    const { programControl, programSelect, viewControl, viewSelect, videoTrackDropdown, videoTrackBtn,
        videoTrackLabel, videoTrackMenu, audioTrackDropdown, audioTrackBtn, audioTrackLabel, audioTrackMenu } = elements;
    const canSelect = !disabled && selected.scope !== null;
    const select = (control: HTMLElement, element: HTMLSelectElement, choices: readonly PresentationChoice[]) => {
        control.hidden = choices.length === 0;
        const active = choices.find(choice => choice.active);
        element.disabled = !canSelect || choices.length === 0 || (choices.length === 1 && active !== undefined);
        element.title = FRESH_PRESENTATION_LABEL;
        element.replaceChildren(...choices.map(choice => {
            const option = document.createElement('option');
            option.value = choice.key;
            option.textContent = choice.label;
            return option;
        }));
        element.value = active?.key ?? '';
        element.onchange = () => {
            const choice = choices.find(item => item.key === element.value);
            // Restore adopted state while teardown/startup is pending or on rejection.
            element.value = active?.key ?? '';
            if (canSelect && !element.disabled && choice && !choice.active) actions.retune(choice, choices);
        };
    };
    select(programControl, programSelect, menus.programs);
    select(viewControl, viewSelect, menus.views);

    const video = menus.videos.find(track => sameTrack(selected.video, track.id));
    videoTrackDropdown.classList.toggle('visible', menus.videos.length > 0);
    videoTrackBtn.disabled = !canSelect || menus.videos.length === 0;
    videoTrackLabel.textContent = video ? video.track.height ? `${video.track.height}p` : trackLabel(video) : 'Video';
    videoTrackMenu.replaceChildren(...menus.videos.map(track => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'track-dropdown-item';
        item.classList.toggle('active', sameTrack(selected.video, track.id));
        item.setAttribute('aria-pressed', String(sameTrack(selected.video, track.id)));
        item.disabled = !canSelect;
        item.title = identityKey(track.id);
        const label = document.createElement('span');
        label.textContent = track.label ?? (track.track.width && track.track.height
            ? `${track.track.width}x${track.track.height}` : track.id.name);
        const detail = document.createElement('span');
        detail.className = 'item-detail';
        detail.textContent = `${track.track.bitrate ? `${(track.track.bitrate / 1000).toFixed(0)}k · ` : ''}${JSON.stringify(track.id.namespaceFields)}`;
        item.appendChild(label);
        item.appendChild(detail);
        item.addEventListener('click', e => {
            e.stopPropagation();
            if (!canSelect || item.disabled) return;
            videoTrackDropdown.classList.remove('open');
            actions.video(reference(track.id));
        });
        return item;
    }));

    const audio = menus.audio.find(choice => choice.active);
    audioTrackDropdown.classList.toggle('visible', menus.audio.length > 0);
    audioTrackBtn.disabled = !canSelect || menus.audio.length === 0;
    audioTrackLabel.textContent = audio?.label ?? 'Audio';
    audioTrackBtn.title = FRESH_PRESENTATION_LABEL;
    audioTrackMenu.replaceChildren(...menus.audio.map(choice => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'track-dropdown-item';
        item.classList.toggle('active', choice.active);
        item.setAttribute('aria-pressed', String(choice.active));
        item.disabled = !canSelect;
        item.title = `${FRESH_PRESENTATION_LABEL} · ${choice.key}`;
        item.textContent = choice.label;
        item.addEventListener('click', e => {
            e.stopPropagation();
            if (!canSelect || item.disabled || choice.active) return;
            audioTrackDropdown.classList.remove('open');
            actions.retune(choice, menus.audio);
        });
        return item;
    }));
    if (!canSelect) {
        videoTrackDropdown.classList.remove('open');
        audioTrackDropdown.classList.remove('open');
    }
}
