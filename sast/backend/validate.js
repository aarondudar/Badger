const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

export const normalizeRepoUrl = (input) => {
  if (typeof input !== 'string' || !input.trim()) {
    return { ok: false, error: 'repoUrl is required' };
  }

  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, error: 'repoUrl is not a valid URL' };
  }

  const parts = url.pathname.split('/').filter(Boolean);
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== 'github.com' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    parts.length !== 2
  ) {
    return { ok: false, error: 'repoUrl must be a public HTTPS GitHub repository URL' };
  }

  const owner = parts[0].toLowerCase();
  const name = parts[1].replace(/\.git$/i, '').toLowerCase();
  if (!NAME.test(owner) || !NAME.test(name) || name === '.' || name === '..') {
    return { ok: false, error: 'owner or repo name contains invalid characters' };
  }

  return {
    ok: true,
    owner,
    name,
    repo: `${owner}/${name}`,
    url: `https://github.com/${owner}/${name}`,
  };
};
