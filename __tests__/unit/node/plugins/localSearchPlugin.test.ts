import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { loadLocalSearchIndex } from 'client/theme-default/support/local-search'
import { resolveConfig } from 'node/config'
import { disposeMdItInstance } from 'node/markdown/markdown'
import { createMarkdownToVueRenderFn } from 'node/markdownToVue'
import { localSearchPlugin } from 'node/plugins/localSearchPlugin'
import type { DefaultTheme } from 'vitepress/theme'

describe('node/plugins/localSearchPlugin', () => {
  let root: string | undefined
  let nodeEnv: string | undefined

  beforeEach(() => {
    nodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    // createMarkdownRenderer is a module-level singleton keyed on nothing —
    // reset it so each test's config actually reaches the renderer
    disposeMdItInstance()
  })

  afterEach(async () => {
    if (nodeEnv === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = nodeEnv
    }

    if (root) {
      await rm(root, { recursive: true, force: true })
      root = undefined
    }
  })

  test('indexes rewritten pages by rewritten locale path', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'vitepress-local-search-'))
    const configDir = path.join(root, '.vitepress')
    await mkdir(configDir)

    await writeFile(
      path.join(root, 'index.md'),
      '# English home\n\nrootonlytoken\n'
    )
    await writeFile(
      path.join(root, 'zh.md'),
      '# Chinese home\n\nlocaleonlytoken\n'
    )
    await writeFile(
      path.join(configDir, 'config.mjs'),
      [
        'export default {',
        '  rewrites: {',
        "    'index.md': 'guide.md',",
        "    'zh.md': 'zh/guide.md'",
        '  },',
        '  locales: {',
        "    root: { label: 'English', lang: 'en' },",
        "    zh: { label: 'Chinese', lang: 'zh' }",
        '  },',
        '  themeConfig: {',
        "    search: { provider: 'local' }",
        '  }',
        '}'
      ].join('\n')
    )

    const siteConfig = await resolveConfig(root, 'build', 'production')
    const plugin = await localSearchPlugin(siteConfig)

    // vite calls configResolved before any other hook
    await (plugin.configResolved as any)?.call(
      {},
      { publicDir: siteConfig.publicDir }
    )

    const indexModule = (await (plugin.load as any)?.handler.call(
      {},
      '/@localSearchIndex'
    )) as string

    expect(indexModule).toContain(
      '"root": () => import(\'@localSearchIndexroot\')'
    )
    expect(indexModule).toContain('"zh": () => import(\'@localSearchIndexzh\')')

    const rootIndex = loadIndex(
      (await (plugin.load as any)?.handler.call(
        {},
        '/@localSearchIndexroot'
      )) as string
    )
    const zhIndex = loadIndex(
      (await (plugin.load as any)?.handler.call(
        {},
        '/@localSearchIndexzh'
      )) as string
    )

    expect(rootIndex.search('rootonlytoken')).toMatchObject([
      { id: '/guide.html#english-home' }
    ])
    expect(rootIndex.search('localeonlytoken')).toEqual([])

    expect(zhIndex.search('localeonlytoken')).toMatchObject([
      { id: '/zh/guide.html#chinese-home' }
    ])
    expect(zhIndex.search('rootonlytoken')).toEqual([])
  })

  test('applies per-locale markdown options (#5350)', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'vitepress-local-search-'))
    const configDir = path.join(root, '.vitepress')
    await mkdir(configDir)
    await mkdir(path.join(root, 'zh'))

    const content = '::: tip\ntipcontent\n:::\n'
    await writeFile(path.join(root, 'index.md'), `# Home\n\n${content}`)
    await writeFile(
      path.join(root, 'zh', 'index.md'),
      `# Chinese home\n\n${content}`
    )
    await writeFile(
      path.join(configDir, 'config.mjs'),
      [
        'export default {',
        '  locales: {',
        "    root: { label: 'English', lang: 'en' },",
        '    zh: {',
        "      label: 'Chinese',",
        "      lang: 'zh',",
        "      markdown: { container: { tipLabel: 'zhtiplabel' } }",
        '    }',
        '  },',
        '  themeConfig: {',
        "    search: { provider: 'local' }",
        '  }',
        '}'
      ].join('\n')
    )

    const siteConfig = await resolveConfig(root, 'build', 'production')
    const plugin = await localSearchPlugin(siteConfig)

    // configResolved hooks run concurrently, so the search plugin may be the
    // one that creates the shared markdown renderer — page renders must still
    // pick up per-locale options from it
    await (plugin.configResolved as any)?.call(
      {},
      { publicDir: siteConfig.publicDir }
    )

    const render = await createMarkdownToVueRenderFn(
      siteConfig.srcDir,
      siteConfig.markdown ?? {},
      siteConfig.site.base,
      false,
      false,
      siteConfig
    )

    const rootFile = path.join(root, 'index.md')
    const zhFile = path.join(root, 'zh', 'index.md')
    const rootPage = await render(await readFile(rootFile, 'utf-8'), rootFile)
    const zhPage = await render(await readFile(zhFile, 'utf-8'), zhFile)
    expect(rootPage.vueSrc).toContain('TIP')
    expect(zhPage.vueSrc).toContain('zhtiplabel')

    // the indexed text must use the localized labels too
    await (plugin.load as any)?.handler.call({}, '/@localSearchIndex')
    const rootIndex = loadIndex(
      (await (plugin.load as any)?.handler.call(
        {},
        '/@localSearchIndexroot'
      )) as string
    )
    const zhIndex = loadIndex(
      (await (plugin.load as any)?.handler.call(
        {},
        '/@localSearchIndexzh'
      )) as string
    )
    expect(zhIndex.search('zhtiplabel')).toHaveLength(1)
    expect(rootIndex.search('zhtiplabel')).toEqual([])
    expect(rootIndex.search('tip')).toHaveLength(1)
  })

  test('segments Chinese and Japanese text by default (#4049)', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'vitepress-local-search-'))
    const configDir = path.join(root, '.vitepress')
    await mkdir(configDir)

    await writeFile(
      path.join(root, 'index.md'),
      '# 首页\n\n全文搜索引擎很好用，日本語の検索機能を改善する。\n'
    )
    await writeFile(
      path.join(configDir, 'config.mjs'),
      "export default { themeConfig: { search: { provider: 'local' } } }"
    )

    const siteConfig = await resolveConfig(root, 'build', 'production')
    const plugin = await localSearchPlugin(siteConfig)
    await (plugin.configResolved as any)?.call(
      {},
      { publicDir: siteConfig.publicDir }
    )
    await (plugin.load as any)?.handler.call({}, '/@localSearchIndex')
    const index = loadIndex(
      (await (plugin.load as any)?.handler.call(
        {},
        '/@localSearchIndexroot'
      )) as string
    )

    expect(index.search('搜索')).toMatchObject([{ id: '/#首页' }])
    expect(index.search('引擎')).toMatchObject([{ id: '/#首页' }])
    expect(index.search('検索')).toMatchObject([{ id: '/#首页' }])
    expect(index.search('改善')).toMatchObject([{ id: '/#首页' }])
    // multi-word query, segmented the same way on both sides
    expect(index.search('検索機能')).toMatchObject([{ id: '/#首页' }])
    expect(index.search('全文搜索')).toMatchObject([{ id: '/#首页' }])
  })

  test('keeps a user provided tokenize', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'vitepress-local-search-'))
    const configDir = path.join(root, '.vitepress')
    await mkdir(configDir)

    await writeFile(path.join(root, 'index.md'), '# Home\n\n全文搜索引擎\n')
    await writeFile(
      path.join(configDir, 'config.mjs'),
      [
        'export default {',
        '  themeConfig: {',
        '    search: {',
        "      provider: 'local',",
        '      options: {',
        '        miniSearch: {',
        '          options: { tokenize: (text) => text.split("") }',
        '        }',
        '      }',
        '    }',
        '  }',
        '}'
      ].join('\n')
    )

    const siteConfig = await resolveConfig(root, 'build', 'production')
    const plugin = await localSearchPlugin(siteConfig)
    await (plugin.configResolved as any)?.call(
      {},
      { publicDir: siteConfig.publicDir }
    )
    await (plugin.load as any)?.handler.call({}, '/@localSearchIndex')
    const index = loadIndex(
      (await (plugin.load as any)?.handler.call(
        {},
        '/@localSearchIndexroot'
      )) as string,
      { options: { tokenize: (text) => text.split('') } }
    )

    // single characters are only indexed when the custom tokenizer is used
    expect(index.search('搜')).toMatchObject([{ id: '/#home' }])
  })

  test('warns and skips pages that fail to render', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'vitepress-local-search-'))
    const configDir = path.join(root, '.vitepress')
    await mkdir(configDir)

    await writeFile(path.join(root, 'index.md'), '# Home\n\nhealthytoken\n')
    await writeFile(
      path.join(root, 'broken.md'),
      '# Broken\n\n<!-- @include: ./missing.md -->\n'
    )
    await writeFile(
      path.join(configDir, 'config.mjs'),
      "export default { themeConfig: { search: { provider: 'local' } } }"
    )

    const siteConfig = await resolveConfig(root, 'build', 'production')
    const warn = vi
      .spyOn(siteConfig.logger, 'warn')
      .mockImplementation(() => {})
    const plugin = await localSearchPlugin(siteConfig)

    await (plugin.configResolved as any)?.call(
      {},
      { publicDir: siteConfig.publicDir }
    )

    // the include throws, but indexing the remaining pages must still resolve —
    // in dev this runs unawaited and a rejection would take the server down
    await (plugin.load as any)?.handler.call({}, '/@localSearchIndex')

    const index = loadIndex(
      (await (plugin.load as any)?.handler.call(
        {},
        '/@localSearchIndexroot'
      )) as string
    )

    expect(index.search('healthytoken')).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to index broken.md for search')
    )
  })

  describe('dev: pages removed while the server runs (#5481)', () => {
    beforeEach(() => {
      // dev mode: `load` serves the live index instead of re-scanning, so only
      // hotUpdate can change it between two reads
      process.env.NODE_ENV = 'development'
    })

    async function setup(files: Record<string, string>, config = '') {
      root = await mkdtemp(path.join(tmpdir(), 'vitepress-local-search-'))
      for (const [file, content] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true })
        await writeFile(path.join(root, file), content)
      }
      await mkdir(path.join(root, '.vitepress'), { recursive: true })
      await writeFile(
        path.join(root, '.vitepress', 'config.mjs'),
        `export default { ${config} themeConfig: { search: { provider: 'local' } } }`
      )

      const siteConfig = await resolveConfig(root, 'serve', 'development')
      const plugin = await localSearchPlugin(siteConfig)
      await (plugin.configResolved as any)?.call(
        {},
        { publicDir: siteConfig.publicDir }
      )

      const server = {
        moduleGraph: {
          onFileChange: vi.fn(),
          getModuleById: vi.fn(() => ({ url: '/@localSearchIndex' }))
        },
        ws: { send: vi.fn() }
      }
      ;(plugin.configureServer as any).call({}, server)
      await (plugin.load as any).handler.call({}, '/@localSearchIndex')
      server.ws.send.mockClear()

      const hotUpdate = (file: string, type: 'create' | 'update' | 'delete') =>
        (plugin.hotUpdate as any).call(
          { environment: { name: 'client' } },
          { file: path.join(root!, file), type }
        )
      const getIndex = async (locale = 'root') =>
        loadIndex(
          (await (plugin.load as any).handler.call(
            {},
            `/@localSearchIndex${locale}`
          )) as string
        )

      return { root, siteConfig, server, hotUpdate, getIndex }
    }

    test('discards every section of a deleted page', async () => {
      const { root, server, hotUpdate, getIndex } = await setup({
        'index.md': '# Home\n\nkeeptoken\n',
        'guide/old.md': '# Old\n\ngonetoken\n\n## Sub\n\ngonetoken again\n'
      })
      expect((await getIndex()).search('gonetoken')).toHaveLength(2)

      await rm(path.join(root, 'guide/old.md'))
      await hotUpdate('guide/old.md', 'delete')

      const index = await getIndex()
      expect(index.search('gonetoken')).toEqual([])
      expect(index.search('keeptoken')).toHaveLength(1)
      // the client must be told to fetch the new index
      expect(server.ws.send).toHaveBeenCalledTimes(1)
    })

    test('keeps only the new path after a rename', async () => {
      const { root, siteConfig, hotUpdate, getIndex } = await setup({
        'guide/old.md': '# Moved\n\nmovedtoken\n'
      })

      // a rename reaches vite as a delete followed by a create
      await rename(
        path.join(root, 'guide/old.md'),
        path.join(root, 'guide/new.md')
      )
      siteConfig.pages = ['guide/new.md']
      await hotUpdate('guide/old.md', 'delete')
      await hotUpdate('guide/new.md', 'create')

      expect((await getIndex()).search('movedtoken')).toMatchObject([
        { id: '/guide/new.html#moved' }
      ])
    })

    test('discards from the right locale index when rewrites apply', async () => {
      const { root, hotUpdate, getIndex } = await setup(
        {
          'index.md': '# Home\n\nroottoken\n',
          'src/zh.md': '# Zh\n\nzhtoken\n'
        },
        `rewrites: { 'src/zh.md': 'zh/guide.md' },
         locales: { root: { label: 'English' }, zh: { label: 'Chinese' } },`
      )
      expect((await getIndex('zh')).search('zhtoken')).toMatchObject([
        { id: '/zh/guide.html#zh' }
      ])

      await rm(path.join(root, 'src/zh.md'))
      await hotUpdate('src/zh.md', 'delete')

      expect((await getIndex('zh')).search('zhtoken')).toEqual([])
      expect((await getIndex()).search('roottoken')).toHaveLength(1)
    })

    test('ignores deleted files that were never indexed', async () => {
      const { root, server, hotUpdate, getIndex } = await setup(
        {
          'index.md': '# Home\n\nkeeptoken\n',
          'parts/snippet.md': 'snippettoken\n'
        },
        `srcExclude: ['parts/**'],`
      )

      await rm(path.join(root, 'parts/snippet.md'))
      await hotUpdate('parts/snippet.md', 'delete')

      expect(server.ws.send).not.toHaveBeenCalled()
      expect((await getIndex()).search('keeptoken')).toHaveLength(1)
    })
  })
})

function loadIndex(
  serializedModule: string,
  miniSearch?: DefaultTheme.MiniSearchOptions
) {
  const serializedIndex = JSON.parse(
    serializedModule.slice('export default '.length)
  )
  // the same way the search box loads it in the browser
  return loadLocalSearchIndex(serializedIndex, miniSearch)
}
