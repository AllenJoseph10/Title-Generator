import { describe, expect, it } from 'vitest';
import { familiesFromNeighbours } from './classify';
import { HOOK_FAMILIES, type HookFamily } from './taxonomy';

const n = (...families: HookFamily[]) => families.map((hookFamily) => ({ hookFamily }));

describe('familiesFromNeighbours', () => {
  it('returns nothing when there are no neighbours', () => {
    // The caller falls back to the keyword selector on the cold-start path,
    // so an empty result must be distinguishable rather than padded.
    expect(familiesFromNeighbours([])).toEqual([]);
  });

  it('returns a single family when every neighbour shares one', () => {
    // Deliberately NOT padded to three. Eight visually-similar videos all
    // using one hook is signal, not a gap — padding it is the exact bug this
    // replaces, where 83% of rows received the same three families.
    expect(familiesFromNeighbours(n('reaction_humblebrag', 'reaction_humblebrag')))
      .toEqual(['reaction_humblebrag']);
  });

  it('orders by frequency, most common first', () => {
    const got = familiesFromNeighbours(
      n(
        'listicle_reveal',
        'relatable_pov', 'relatable_pov', 'relatable_pov',
        'transformation_tease', 'transformation_tease',
      ),
    );
    expect(got).toEqual(['relatable_pov', 'transformation_tease', 'listicle_reveal']);
  });

  it('caps at three even when neighbours span all five families', () => {
    const got = familiesFromNeighbours(n(...HOOK_FAMILIES));
    expect(got).toHaveLength(3);
  });

  it('honours an explicit max', () => {
    const got = familiesFromNeighbours(n(...HOOK_FAMILIES), 2);
    expect(got).toHaveLength(2);
  });

  it('breaks frequency ties by taxonomy declaration order, deterministically', () => {
    // reaction_humblebrag is declared after relatable_pov, so on an equal
    // count relatable_pov wins. Determinism matters: the same video must
    // produce the same prompt on every run.
    const a = familiesFromNeighbours(n('reaction_humblebrag', 'relatable_pov'), 1);
    const b = familiesFromNeighbours(n('relatable_pov', 'reaction_humblebrag'), 1);
    expect(a).toEqual(['relatable_pov']);
    expect(b).toEqual(['relatable_pov']);
  });

  it('never returns a duplicate family', () => {
    const got = familiesFromNeighbours(n('relatable_pov', 'relatable_pov', 'relatable_pov'));
    expect(got).toEqual(['relatable_pov']);
    expect(new Set(got).size).toBe(got.length);
  });

  it('surfaces a family the keyword selector almost never picks', () => {
    // reaction_humblebrag has the strongest prior correlation in the eval
    // (0.411) yet the keyword selector requested it for only 12% of rows.
    // When the neighbours use it, it must come through.
    expect(familiesFromNeighbours(n('reaction_humblebrag', 'reaction_humblebrag', 'relatable_pov')))
      .toContain('reaction_humblebrag');
  });
});
