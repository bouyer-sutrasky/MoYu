/** One exact GitHub Issue or Pull Request reference in a message. */
export interface GithubRequirement {
  number: number;
  isPr: boolean;
}

/**
 * Finds exact GitHub Issue/PR URLs for `repository` in free text. The number is
 * bounded so `/issues/1` does not match `/issues/10` or `/issues/11`, and query
 * strings/fragments after the number are allowed.
 */
export function githubRequirementsIn(text: string, repository: string): GithubRequirement[] {
  const escaped = repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    String.raw`https?:\/\/(?:www\.)?github\.com\/${escaped}\/(issues|pulls?)\/(\d+)(?![0-9A-Za-z_-])`,
    'gi',
  );
  const found: GithubRequirement[] = [];
  for (const match of text.matchAll(pattern)) {
    const number = Number(match[2]);
    const isPr = match[1]!.toLowerCase().startsWith('pull');
    if (!found.some((item) => item.number === number && item.isPr === isPr)) {
      found.push({ number, isPr });
    }
  }
  return found;
}

/** Whether `text` contains the exact GitHub Issue/PR URL for this repository. */
export function githubRequirementUrl(
  text: string,
  repository: string,
  isPr: boolean,
  number: number,
): boolean {
  return githubRequirementsIn(text, repository).some(
    (item) => item.number === number && item.isPr === isPr,
  );
}
