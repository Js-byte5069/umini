// Ground dressing: debris, wrecked machinery, snow-buried ruin pieces and route composition props
// (placeholder: filled in by the polish pass; world.js calls dressingWorld after the structures and before the boulder scatter).
export async function loadDressing() {}

/** @param {{job: Function, put: Function, ground: Function, keepClear: Array, colliders: Array}} ctx */
export function dressingWorld(ctx) { return { items: 0 }; }
