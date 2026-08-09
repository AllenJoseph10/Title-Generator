import { describe, it, expect } from 'vitest';
import { renderFeedbackReport, type FeedbackRow } from './feedback-report';

// Counts are deliberately asymmetric (2 kept, 1 rejected) with distinguishable
// titles, so a filter swap in the renderer (vote === 1 <-> vote === -1) changes
// the rendered counts AND moves a specific title into the wrong section —
// either would fail these tests. See the placement test below.
const rows: FeedbackRow[] = [
  {
    creatorHandle: 'henryjwade',
    vote: 1,
    title: 'The coat that does all the work',
    hookFamily: 'transformation_tease',
    visualDescription: 'man in a wool overcoat, city street at dusk',
    generationId: 'gen-1',
    createdAt: '2026-08-09T10:00:00Z',
  },
  {
    creatorHandle: 'henryjwade',
    vote: 1,
    title: 'The blazer that changes everything',
    hookFamily: 'transformation_tease',
    visualDescription: 'man in a wool overcoat, city street at dusk',
    generationId: 'gen-2',
    createdAt: '2026-08-09T10:02:00Z',
  },
  {
    creatorHandle: 'henryjwade',
    vote: -1,
    title: 'A guide to autumn outerwear',
    hookFamily: 'listicle_reveal',
    visualDescription: 'man in a wool overcoat, city street at dusk',
    generationId: 'gen-1',
    createdAt: '2026-08-09T10:01:00Z',
  },
];

describe('renderFeedbackReport', () => {
  it('counts both directions in the header', () => {
    const out = renderFeedbackReport(rows, '2026-08-09T12:00:00Z');
    expect(out).toContain('2 kept');
    expect(out).toContain('1 rejected');
  });

  it('groups by creator and separates the two directions', () => {
    const out = renderFeedbackReport(rows, '2026-08-09T12:00:00Z');
    expect(out).toContain('## @henryjwade');
    expect(out).toContain('### Kept');
    expect(out).toContain('### Rejected');
  });

  it('places each title under the correct heading, not the other one', () => {
    const out = renderFeedbackReport(rows, '2026-08-09T12:00:00Z');
    const [beforeRejected, afterRejected] = out.split('### Rejected');

    // Kept titles: present before the "### Rejected" heading, absent after it.
    expect(beforeRejected).toContain('The coat that does all the work');
    expect(afterRejected).not.toContain('The coat that does all the work');
    expect(beforeRejected).toContain('The blazer that changes everything');
    expect(afterRejected).not.toContain('The blazer that changes everything');

    // Rejected title: present after the heading, absent before it.
    expect(afterRejected).toContain('A guide to autumn outerwear');
    expect(beforeRejected).not.toContain('A guide to autumn outerwear');
  });

  it('shows the visual description each title was generated for', () => {
    expect(renderFeedbackReport(rows, '2026-08-09T12:00:00Z')).toContain(
      'man in a wool overcoat, city street at dusk',
    );
  });

  it('says so plainly when there is nothing to review', () => {
    expect(renderFeedbackReport([], '2026-08-09T12:00:00Z')).toContain('No votes recorded yet');
  });
});
