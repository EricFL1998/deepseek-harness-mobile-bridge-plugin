/**
 * 原生插件商店索引器：GitHub tag 模式。
 *
 * 挂了 `dsh-mobile-plugin` tag 的 GitHub 仓库会被收入商店索引。本脚本：
 * 1. 用 GitHub 的 topic 搜索 API 找带该 tag 的仓库；
 * 2. 读每个仓库的 `package.json` 里的 `dsh.native` 声明（pluginId/能力/版本）；
 * 3. 汇总成一份索引 JSON，供 App 的「原生插件」tab 拉取。
 *
 * 用法：
 *   GITHUB_TOKEN=… node --experimental-strip-types scripts/build-store-index.ts > store-index.json
 *
 * 索引是**签名 JSON**：发布前用商店私钥签名，App 用内置公钥验签后才采信。
 */

const TOPIC = 'dsh-mobile-plugin'
const API = 'https://api.github.com'

interface RepoResult {
  full_name: string
  description: string | null
  html_url: string
  default_branch: string
}

interface NativeDeclaration {
  pluginId?: string
  name?: string
  apiVersion?: number
  minAppVersion?: number
  capabilities?: string[]
  storeUrl?: string
}

interface StoreEntry {
  pluginId: string
  name: string
  description: string
  repoUrl: string
  apiVersion?: number
  minAppVersion?: number
  capabilities: string[]
}

async function github(path: string, token: string): Promise<Response> {
  return fetch(`${API}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
}

async function searchRepos(token: string): Promise<RepoResult[]> {
  const out: RepoResult[] = []
  let page = 1
  while (true) {
    const res = await github(`/search/repositories?q=topic:${TOPIC}&per_page=100&page=${page}`, token)
    if (!res.ok) throw new Error(`GitHub search failed: ${res.status}`)
    const body = (await res.json()) as { items?: RepoResult[] }
    const items = body.items ?? []
    out.push(...items)
    if (items.length < 100) break
    page += 1
  }
  return out
}

/** 读一个仓库根 package.json 的 dsh.native 声明；读不到返回 null。 */
async function readDeclaration(repo: RepoResult, token: string): Promise<NativeDeclaration | null> {
  const res = await github(
    `/repos/${repo.full_name}/contents/package.json?ref=${repo.default_branch}`,
    token,
  )
  if (!res.ok) return null
  const body = (await res.json()) as { content?: string; encoding?: string }
  if (body.encoding !== 'base64' || !body.content) return null
  try {
    const text = Buffer.from(body.content, 'base64').toString('utf8')
    const pkg = JSON.parse(text) as { dsh?: { native?: NativeDeclaration } }
    return pkg.dsh?.native ?? null
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const token = process.env.GITHUB_TOKEN
  if (!token) throw new Error('GITHUB_TOKEN is required (topic search + raw content)')
  const repos = await searchRepos(token)
  const entries: StoreEntry[] = []
  for (const repo of repos) {
    const decl = await readDeclaration(repo, token)
    if (!decl?.pluginId) continue
    entries.push({
      pluginId: decl.pluginId,
      name: decl.name ?? repo.full_name.split('/')[1] ?? repo.full_name,
      description: repo.description ?? '',
      repoUrl: repo.html_url,
      apiVersion: decl.apiVersion,
      minAppVersion: decl.minAppVersion,
      capabilities: decl.capabilities ?? [],
    })
  }
  const index = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    topic: TOPIC,
    entries,
  }
  process.stdout.write(JSON.stringify(index, null, 2) + '\n')
  process.stderr.write(`indexed ${entries.length}/${repos.length} repos tagged '${TOPIC}'\n`)
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).message}\n`)
  process.exit(1)
})
