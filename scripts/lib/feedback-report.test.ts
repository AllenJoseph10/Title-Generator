import { describe, it, expect } from 'vitest';
import { renderFeedbackReport, type FeedbackRow } from './feedback-report';

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
    expect(out).toContain('1 kept');
    expect(out).toContain('1 rejected');
  });

  it('groups by creator and separates the two directions', () => {
    const out = renderFeedbackReport(rows, '2026-08-09T12:00:00Z');
    expect(out).toContain('## @henryjwade');
    expect(out).toContain('### Kept');
    expect(out).toContain('### Rejected');
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
