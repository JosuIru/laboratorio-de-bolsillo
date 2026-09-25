import { parseStoredBestScores, recordScore } from './bestScores';

describe('récords', () => {
  it('lee los récords válidos y descarta lo demás', () => {
    expect(parseStoredBestScores(null)).toEqual({});
    expect(parseStoredBestScores('roto')).toEqual({});
    expect(parseStoredBestScores(JSON.stringify({ easy: 1500, hard: 'mucho', medium: -3 }))).toEqual({ easy: 1500 });
  });

  it('solo sustituye el récord si se mejora', () => {
    expect(recordScore({ easy: 1500 }, 'easy', 1400)).toEqual({ easy: 1500 });
    expect(recordScore({ easy: 1500 }, 'easy', 1600)).toEqual({ easy: 1600 });
    expect(recordScore({}, 'hard', 0)).toEqual({ hard: 0 });
  });
});
