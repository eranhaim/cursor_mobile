/** Cursor Cloud Agents accept HTTPS clone URLs for GitHub repos. */

export type RepoSummary = {
  full_name: string;
  clone_url: string;
  html_url: string;
};

function parseHasNext(linkHeader: string | null): boolean {
  if (!linkHeader) return false;
  return linkHeader.split(",").some((chunk) => chunk.includes('rel="next"'));
}

export async function fetchMyRepos(
  token: string,
  options: { page?: number; perPage?: number } = {},
): Promise<{ repos: RepoSummary[]; hasNext: boolean }> {
  const page = options.page ?? 1;
  const perPage = Math.min(Math.max(options.perPage ?? 12, 1), 30);

  const url = new URL("https://api.github.com/user/repos");
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("page", String(page));
  url.searchParams.set("sort", "pushed");
  url.searchParams.set("affiliation", "owner,collaborator,organization_member");

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GitHub list failed (${res.status}): ${t.slice(0, 500)}`);
  }

  const body = (await res.json()) as Array<{
    full_name: string;
    clone_url: string;
    html_url: string;
  }>;

  const repos = body.map((r) => ({
    full_name: r.full_name,
    clone_url: r.clone_url,
    html_url: r.html_url,
  }));

  return { repos, hasNext: parseHasNext(res.headers.get("link")) };
}

export async function createUserRepo(
  token: string,
  name: string,
  opts: { privateRepo?: boolean } = {},
): Promise<RepoSummary> {
  const res = await fetch("https://api.github.com/user/repos", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      private: opts.privateRepo !== false,
      auto_init: true,
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GitHub create repo failed (${res.status}): ${t.slice(0, 500)}`);
  }

  const r = (await res.json()) as {
    full_name: string;
    clone_url: string;
    html_url: string;
  };

  return {
    full_name: r.full_name,
    clone_url: r.clone_url,
    html_url: r.html_url,
  };
}
