import path from 'node:path'
import { createFilter } from 'vite'
import { parse } from '@astrojs/compiler'
import { walk } from 'estree-walker'
import MagicString from 'magic-string'

const knownFrameworks = ['svelte', 'vue', 'solid', 'preact', 'react']

// credit: Vite
const importsRE =
  /(?<!\/\/.*)(?<=^|;|\*\/)\s*import(?!\s+type)([\w*{}\n\r\t, ]+)from\s*\s*("[^"]+"|'[^']+')\s*(?=$|;|\/\/|\/\*)/gm

/**
 * @type {import('.').whyframeAstro}
 */
export function whyframeAstro(options) {
  /** @type {import('@whyframe/core').Api} */
  let api

  const filter = createFilter(options?.include || /\.astro$/, options?.exclude)
  const componentNames = options?.components?.map((c) => c.name) ?? []
  const componentPaths =
    options?.components?.flatMap((c) => [c.path, path.resolve(c.path)]) ?? []

  /** @type {import('vite').Plugin} */
  const plugin = {
    name: 'whyframe:astro',
    enforce: 'pre',
    configResolved(c) {
      api = c.plugins.find((p) => p.name === 'whyframe:api')?.api
      if (!api) {
        // TODO: maybe fail safe
        throw new Error('whyframe() plugin is not installed')
      }

      // run our plugin before astro's
      const astro = c.plugins.findIndex((p) => p.name === 'astro:build')
      if (astro !== -1) {
        const myIndex = c.plugins.findIndex((p) => p.name === 'whyframe:astro')
        if (myIndex !== -1) {
          c.plugins.splice(myIndex, 1)
          c.plugins.splice(astro, 0, plugin)
          delete plugin.enforce
        }
      }
    },
    async transform(code, id) {
      if (!filter(id) || id.includes('__whyframe-')) return
      if (
        !code.includes('<iframe') &&
        componentNames.every((n) => !code.includes(`<${n}`))
      )
        return

      const isProxyMode = componentPaths.includes(id)

      // parse instances of `<iframe data-why></iframe>` and extract them out as a virtual import
      const s = new MagicString(code)

      const ast = (await parse(code, { position: true })).ast

      // collect code needed for virtual imports, assume all these have side effects
      let frontmatterCode =
        ast.children[0]?.type === 'frontmatter' ? ast.children[0].value : ''

      // this removes imports from .astro files, in most cases this isn't needed,
      // but svelte seems to treat the styles in the .astro file as side-effectful
      // and include it in the iframe
      if (frontmatterCode) {
        const toPrependCode = []
        frontmatterCode = frontmatterCode.replace(importsRE, (ori, m1, m2) => {
          if (m2.slice(0, -1).endsWith('.astro')) {
            toPrependCode.push(`const ${m1} = {}`)
            return ''
          } else {
            return ori
          }
        })
        frontmatterCode = toPrependCode.join('\n') + '\n' + frontmatterCode
      }

      // generate initial hash
      const baseHash = api.getHash(frontmatterCode)

      // shim Astro global
      frontmatterCode = shimAstro + '\n\n' + frontmatterCode

      walk(ast, {
        enter(node) {
          const isIframeElement =
            node.type === 'element' &&
            node.name === 'iframe' &&
            node.attributes.find((a) => a.name === 'data-why')

          if (isProxyMode) {
            // proxy mode only process iframe elements
            if (isIframeElement) {
              const attrs = api.getProxyIframeAttrs()
              s.appendLeft(
                node.position.start.offset + `<iframe`.length,
                stringifyAttrs(attrs)
              )
              this.skip()
            }
            return
          }

          const isIframeComponent =
            node.type === 'component' && componentNames.includes(node.name)

          if (isIframeElement || isIframeComponent) {
            // .astro requires a value for data-why to render as a specific framework
            const whyPropName = isIframeComponent ? 'why' : 'data-why'

            /** @type {import('.').Options['defaultFramework']} */
            const framework =
              node.attributes.find((a) => a.name === whyPropName)?.value ||
              options?.defaultFramework

            if (!framework) {
              // TODO: generate frame
              console.warn(
                `<${node.name} ${whyPropName}> in .astro files must specify a value for ${whyPropName}, e.g. <${node.name} ${whyPropName}="svelte">. ` +
                  `Supported frameworks include ${knownFrameworks
                    .map((f) => `"${f}"`)
                    .join(', ')}.`
              )
              return
            }
            if (!knownFrameworks.includes(framework)) {
              // TODO: generate frame
              console.warn(
                `<${node.name} ${whyPropName}="${framework}"> isn't supported. ` +
                  `Supported frameworks include ${knownFrameworks
                    .map((f) => `"${f}"`)
                    .join(', ')}.`
              )
              return
            }

            // extract iframe html
            // TODO: Astro to framework generation
            let iframeContent = ''
            if (node.children.length > 0) {
              const start = node.children[0].position.start.offset
              const end = node.position.end.offset - `</`.length // astro position ends until </
              iframeContent = code.slice(start, end)
              s.remove(start, end)
            }

            // derive final hash per iframe
            const finalHash = api.getHash(baseHash + iframeContent)

            const entryComponentId = api.createEntryComponent(
              id,
              finalHash,
              framework === 'svelte'
                ? '.svelte'
                : framework === 'vue'
                ? '.vue'
                : '.tsx',
              createEntryComponent(frontmatterCode, iframeContent, framework)
            )

            const entryId = api.createEntry(
              id,
              finalHash,
              getEntryExtension(framework),
              createEntry(entryComponentId, framework)
            )

            // inject template props
            const templatePropName = isIframeComponent
              ? 'whyTemplate'
              : 'data-why-template'
            const templateName = node.attributes.find(
              (a) => a.name === templatePropName
            )?.value
            const attrs = api.getMainIframeAttrs(
              entryId,
              finalHash,
              templateName,
              isIframeComponent
            )
            const injectOffset = isIframeComponent
              ? 1 + node.name.length
              : `<iframe`.length
            s.appendLeft(
              node.position.start.offset + injectOffset,
              stringifyAttrs(attrs)
            )
          }
        }
      })

      if (s.hasChanged()) {
        return {
          code: s.toString(),
          map: s.generateMap({ hires: true })
        }
      }
    }
  }

  return plugin
}

function getEntryExtension(framework) {
  switch (framework) {
    case 'svelte':
    case 'vue':
      return '.js'
    case 'solid':
    case 'preact':
    case 'react':
      return '.jsx'
  }
}

/**
 * @param {string} entryId
 * @param {import('.').Options['defaultFramework']} framework
 */
function createEntry(entryId, framework) {
  switch (framework) {
    case 'svelte':
      return `\
import App from '${entryId}'

export function createApp(el) {
  new App({ target: el })
}`
    case 'vue':
      return `\
import { createApp as _createApp } from 'vue'
import App from '${entryId}'

export function createApp(el) {
  _createApp(App).mount(el)
}`
    case 'react':
      return `\
import React from 'react'
import ReactDOM from 'react-dom/client'
import { WhyframeApp } from '${entryId}'

export function createApp(el) {
  ReactDOM.createRoot(el).render(<WhyframeApp />)
}`
    case 'preact':
      return `\
import { render } from 'preact'
import { WhyframeApp } from '${entryId}'

export function createApp(el) {
  render(<WhyframeApp />, el)
}`
    case 'solid':
      return `\
import { render } from 'solid-js/web'
import { WhyframeApp } from '${entryId}'

export function createApp(el) {
  render(() => <WhyframeApp />, el)
}`
  }
}

/**
 * @param {string} contextCode
 * @param {string} iframeHtmlCode
 * @param {import('.').Options['defaultFramework']} framework
 */
function createEntryComponent(contextCode, iframeHtmlCode, framework) {
  switch (framework) {
    case 'svelte':
      return `\
<script>
  ${contextCode}
</script>

${iframeHtmlCode}`
    case 'vue':
      return `\
<script setup>
  ${contextCode}
</script>

<template>
  ${iframeHtmlCode}
</template>`
    case 'solid':
    case 'preact':
    case 'react':
      const source = framework === 'solid' ? 'solid-js' : framework
      return `\
/** @jsxImportSource ${source} */

${contextCode}

export function WhyframeApp() {
  return (
    <>
      ${iframeHtmlCode}
    </>
  )
}`
  }
}

// TODO: dont be lazy
const shimAstro = `\
const Astro = {
  site: undefined,
  generator: 'whyframe',
  glob: () => [],
  resolve: (s) => s
}`

/**
 * @param {import('@whyframe/core').Attr[]} attrs
 */
function stringifyAttrs(attrs) {
  let str = ''
  for (const attr of attrs) {
    if (attr.type === 'static') {
      str += ` ${attr.name}="${attr.value}"`
    } else {
      str += ` ${attr.name}={Astro.props.${attr.value}}`
    }
  }
  return str
}
