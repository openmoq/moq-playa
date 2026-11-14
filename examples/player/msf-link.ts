/**
 * MSF URL support for the player page (draft-ietf-moq-msf-01 §11.1).
 *
 * The MSF fragment lives in the PAGE'S FRAGMENT, which a browser never sends
 * to the server that hosts the page:
 *
 *   …/player/?url=https://relay/moq#msf:<namespace>--catalog&c4m=<token>
 *
 * The relay comes from `?url=` (or endpoint discovery) as before. The token is
 * never in a query string, which is the point: a `?msf=` parameter would hand
 * it to the page's host and its logs.
 *
 * No `window` access — the page passes `location.hash` and `location.search`.
 * Nothing here logs or echoes the fragment.
 */

import { parseMsfFragment } from '../shared/msf-url.js';
import type { PlayerAuthorization } from '@openmoq/player';
import { catAuthorization, catTokenType } from '../shared/cat-authorization.js';

export interface PlayerMsfLink {
    /** Namespace tuple; replaces `?ns=` / `?nsField=`. */
    readonly namespace: readonly string[];
    /** The track the URL names. This page can only start from a catalog, so it is subscribed as one. */
    readonly catalogTrackName: string;
    /** Presents the `c4m` token, typed per `?authProfile=`. */
    readonly authorization?: PlayerAuthorization;
    /** Parts of the fragment this page does not act on. Safe to log: a count, never names or values. */
    readonly notes: readonly string[];
}

/**
 * Read the MSF fragment of a page, or `undefined` when the fragment holds none
 * (empty, or not beginning with `msf:`), in which case the page's query
 * parameters apply unchanged.
 *
 * The `c4m` token is sent as the CAT4MOQ token type unless `?authProfile=moqx-compat`
 * selects the type current moqx relays expect. The profile is not a secret and
 * stays in the query string.
 *
 * @throws {Error} a malformed MSF fragment; `connection=q`, which a browser
 *   cannot honour and §11.1.1 does not allow it to ignore; a namespace given
 *   both in the fragment and in the query string; an invalid `?authProfile=`.
 */
export function readMsfLink(hash: string, search: string): PlayerMsfLink | undefined {
    const text = hash.startsWith('#') ? hash.slice(1) : hash;
    if (!/^msf:/i.test(text)) return undefined;
    const query = new URLSearchParams(search);
    const fragment = parseMsfFragment(text);
    for (const name of ['ns', 'nsField']) {
        if (query.has(name)) throw new Error(`MSF URL and ?${name}= both set the same thing; remove ?${name}=`);
    }
    if (fragment.connection === 'q') {
        throw new Error('MSF URL requires a native QUIC connection (connection=q); a browser can only use WebTransport');
    }

    const ignored = fragment.parameters.length;
    const notes = ignored > 0 ? [`${ignored} parameter${ignored > 1 ? 's are' : ' is'} not supported by this page and ignored`] : [];

    let authorization: PlayerAuthorization | undefined;
    if (fragment.c4m !== undefined) {
        // The pre-fetch connects on its own, outside the player's authorization.
        if (query.get('fetchCatalog') === '1') throw new Error('MSF URL c4m token cannot be combined with ?fetchCatalog=1 on this page');
        authorization = catAuthorization(catTokenType(query.get('authProfile') ?? 'cat4moq'), fragment.c4m);
    }

    return {
        namespace: fragment.namespace,
        catalogTrackName: fragment.trackName,
        ...(authorization ? { authorization } : {}),
        notes,
    };
}
