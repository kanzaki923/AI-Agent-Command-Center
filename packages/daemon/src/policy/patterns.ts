/**
 * Containment of permission patterns (see `matchPattern` in @acc/protocol):
 * - `*` alone matches every name.
 * - A trailing `.*` matches one or more remaining segments (`task.*` ⊇ `task.create`, `task.a.b`).
 * - `*` elsewhere matches exactly one segment (`*.list` ⊇ `task.list`).
 *
 * `patternContains(p, c)` is true iff every name matched by `c` is also matched by `p`.
 * Delegation uses it so that an agent can only hand out what it holds itself.
 */
export function patternContains(parent: string, child: string): boolean {
  if (parent === '*') return true;
  if (child === '*') return false;
  if (parent === child) return true;

  const p = parent.split('.');
  const c = child.split('.');
  const pTail = p.length > 1 && p[p.length - 1] === '*';
  const cTail = c.length > 1 && c[c.length - 1] === '*';

  /** Segment i of the parent covers segment i of the child. */
  const covers = (i: number) => p[i] === '*' || (c[i] !== '*' && p[i] === c[i]);

  if (!pTail) {
    // Parent matches names of exactly p.length segments; so must the child.
    if (cTail || c.length !== p.length) return false;
    for (let i = 0; i < p.length; i++) if (!covers(i)) return false;
    return true;
  }

  // Parent matches names with >= p.length segments whose first p.length-1 segments match.
  // The child's shortest names have c.length segments (also when it ends with `.*`).
  if (c.length < p.length) return false;
  for (let i = 0; i < p.length - 1; i++) if (!covers(i)) return false;
  return true;
}

/** Whether some pattern of `parents` contains `child`. */
export function anyPatternContains(parents: readonly string[], child: string): boolean {
  return parents.some((p) => patternContains(p, child));
}
