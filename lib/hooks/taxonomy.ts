// Single source of truth for the 5 hook families.
// Imported by: prompts, classifier, providers, eval harness.

export const HOOK_FAMILIES = [
  'relatable_pov',
  'setup_trivial_reveal',
  'listicle_reveal',
  'reaction_humblebrag',
  'transformation_tease',
] as const;

export type HookFamily = (typeof HOOK_FAMILIES)[number];

export type HookFamilyMeta = {
  id: HookFamily;
  displayName: string;
  template: string;
  example: string;
  triggers: ReadonlyArray<string>;
};

export const HOOK_TAXONOMY: Readonly<Record<HookFamily, HookFamilyMeta>> = {
  relatable_pov: {
    id: 'relatable_pov',
    displayName: 'Relatable POV',
    template: 'Me ${verb-ing} ${mundane}…',
    example: "Me praying the hotel room meets my girlfriend's high standards…",
    triggers: ['mundane', 'awkward', 'anxious', 'waiting', 'getting-ready', 'hotel', 'first-person', 'pov'],
  },
  setup_trivial_reveal: {
    id: 'setup_trivial_reveal',
    displayName: 'Setup + Trivial Reveal',
    template: '${grand setup}. ${trivial reveal}:',
    example: 'Life is full of hard decisions. The decisions:',
    triggers: ['decision', 'choice', 'list', 'options', 'reveal', 'multi-shot'],
  },
  listicle_reveal: {
    id: 'listicle_reveal',
    displayName: 'Listicle Reveal',
    template: 'Me and my ${N} ${things}:',
    example: 'Me and my 3 personalities:',
    triggers: ['multiple', 'series', 'collection', 'outfits', 'looks', 'versions'],
  },
  reaction_humblebrag: {
    id: 'reaction_humblebrag',
    displayName: 'Reaction Humblebrag',
    template: 'When ${X happens} but ${flex}…',
    example: 'When some old person says they went to school with me…',
    triggers: ['react', 'flex', 'humble-brag', 'comparison', 'looking-young', 'looking-good'],
  },
  transformation_tease: {
    id: 'transformation_tease',
    displayName: 'Transformation Tease',
    template: 'Anyone can go from this: / POV: how life feels when ${aspiration}…',
    example: 'Anyone can go from this:',
    triggers: ['transformation', 'before-after', 'aspiration', 'glow-up', 'reveal', 'change'],
  },
};

export function isHookFamily(s: string): s is HookFamily {
  return (HOOK_FAMILIES as readonly string[]).includes(s);
}
