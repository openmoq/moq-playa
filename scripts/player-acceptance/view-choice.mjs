/** Find one declared view by its exact UI key; singleton identities are not group numbers. */
export function viewChoiceValue(values, group) {
  const matches = values.filter(value => {
    let key;
    try { key = JSON.parse(value); } catch { return false; }
    return Array.isArray(key) && key.length === 3 && key[0] === 'view' && key[2] === group;
  });
  if (matches.length !== 1) throw new Error(`Expected one view choice for group ${group}; found ${matches.length}`);
  return matches[0];
}

/** Program keys preserve the distinction between declared group zero and unassigned. */
export function programChoiceValue(values, group) {
  const matches = values.filter(value => {
    let key;
    try { key = JSON.parse(value); } catch { return false; }
    return Array.isArray(key) && key.length === 2 && key[0] === 'scope'
      && (group === null ? key[1]?.kind === 'unassigned'
        : key[1]?.kind === 'render-group' && key[1].renderGroup === group);
  });
  if (matches.length !== 1) throw new Error(`Expected one program choice for group ${group}; found ${matches.length}`);
  return matches[0];
}
