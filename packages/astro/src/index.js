import { builtinModules } from 'node:module'
import { createFilter } from 'vite'
import { parse } from '@astrojs/compiler'
import { walk } from 'estree-walker'
import MagicString from 'magic-string'
import { dedent, hash } from '@whyframe/core/pluginutils'

const knownFrameworks = ['svelte', 'vue', 'solid', 'preact', 'react']

const knownNodeImports = ['astro/components']

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

      // run jsx plugin before astro's
      const astroJsx = c.plugins.find((p) => p.name === 'astro:jsx')
      if (astroJsx !== -1) {
        const seenJsxPlugins = new Set()
        while (true) {
          const whyframeJsxIndex = c.plugins.findIndex(
            (p) => p.name === 'whyframe:jsx' && !seenJsxPlugins.has(p)
          )
          if (whyframeJsxIndex !== -1) {
            const whyframeJsx = c.plugins[whyframeJsxIndex]
            const astroJsxIndex = c.plugins.findIndex(
              (p) => p.name === 'astro:jsx'
            )
            seenJsxPlugins.add(whyframeJsx)
            c.plugins.splice(whyframeJsxIndex, 1)
            c.plugins.splice(astroJsxIndex, 0, whyframeJsx)
          } else {
            break
          }
        }
      }
    },
    async transform(code, id) {
      if (!filter(id)) return
      if (!api.moduleMayHaveIframe(id, code)) return

      // parse instances of `<iframe data-why></iframe>` and extract them out as a virtual import
      const s = new MagicString(code)

      const ast = (await parse(code, { position: true })).ast

      // collect code needed for virtual imports, assume all these have side effects
      let frontmatterCode =
        ast.children[0]?.type === 'frontmatter' ? ast.children[0].value : ''

      // we're transferring frontmatter code to framework code (node => browser).
      // so remove potential node imports that may break
      if (frontmatterCode) {
        frontmatterCode = frontmatterCode.replace(importsRE, (ori, m1, m2) => {
          /** @type {string} */
          const importSpecifier = m2.slice(1, -1)
          if (
            importSpecifier.endsWith('.astro') ||
            importSpecifier.startsWith('node:') ||
            builtinModules.includes(importSpecifier) ||
            knownNodeImports.includes(importSpecifier)
          ) {
            return ''
          } else {
            return ori
          }
        })
      }

      let styleCode = ''
      for (const node of ast.children) {
        if (node.type === 'element' && node.name === 'style') {
          styleCode += code.slice(
            node.position.start.offset - `<`.length,
            node.position.end.offset + `style>`.length
          )
        }
      }

      // generate initial hash
      const baseHash = hash(frontmatterCode + styleCode)

      // shim Astro global
      frontmatterCode = shimAstro + '\n\n' + frontmatterCode

      walk(ast, {
        enter(node) {
          const isIframeElement =
            node.type === 'element' &&
            node.name === 'iframe' &&
            node.attributes.some((a) => a.name === 'data-why')

          if (isIframeElement) {
            // if contains slot, it implies that it's accepting the component's
            // slot as iframe content, we need to proxy them
            if (
              node.children?.some((c) =>
                c.value?.trimLeft().startsWith('<slot')
              )
            ) {
              const attrs = api.getProxyIframeAttrs()
              addAttrs(s, node, attrs)
              s.remove(
                node.children[0].position.start.offset,
                node.position.end.offset - `</`.length // astro position ends until </
              )
              this.skip()
              return
            }
          }

          const isIframeComponent =
            node.type === 'component' && api.getComponent(node.name)

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
            const finalHash = hash(baseHash + iframeContent)

            const entryComponentId = api.createEntryComponent(
              id,
              finalHash,
              framework === 'svelte'
                ? '.svelte'
                : framework === 'vue'
                ? '.vue'
                : '.tsx',
              createEntryComponent(
                frontmatterCode,
                styleCode,
                iframeContent,
                framework
              )
            )

            const entryId = api.createEntry(
              id,
              finalHash,
              getEntryExtension(framework),
              createEntry(entryComponentId, framework)
            )

            // inject props
            const attrs = api.getMainIframeAttrs(
              entryId,
              finalHash,
              node.attributes.some((a) => a.name === 'data-why-source')
                ? dedent(iframeContent)
                : undefined,
              isIframeComponent
            )
            addAttrs(s, node, attrs)
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
 * @param {string} frontmatterCode
 * @param {string} styleCode
 * @param {string} iframeHtmlCode
 * @param {import('.').Options['defaultFramework']} framework
 */
function createEntryComponent(
  frontmatterCode,
  styleCode,
  iframeHtmlCode,
  framework
) {
  switch (framework) {
    case 'svelte':
      return `\
<script>
  ${frontmatterCode}
</script>

${iframeHtmlCode}

${styleCode}`
    case 'vue':
      return `\
<script setup>
  ${frontmatterCode}
</script>

<template>
  ${iframeHtmlCode}
</template>

${styleCode}`
    case 'solid':
    case 'preact':
    case 'react':
      const source = framework === 'solid' ? 'solid-js' : framework
      return `\
/** @jsxImportSource ${source} */

${frontmatterCode}

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
 * @param {MagicString} s
 * @param {any} node
 * @param {import('@whyframe/core').Attr[]} attrs
 */
function addAttrs(s, node, attrs) {
  const attrNames = node.attributes.map((a) => a.name)

  const safeAttrs = []
  const mixedAttrs = []
  for (const attr of attrs) {
    if (attrNames.includes(attr.name)) {
      mixedAttrs.push(attr)
    } else {
      safeAttrs.push(attr)
    }
  }

  s.appendLeft(
    node.position.start.offset + node.name.length + 1,
    safeAttrs.map((a) => ` ${a.name}={${parseAttrToString(a)}}`).join('')
  )

  for (const attr of mixedAttrs) {
    const attrNodeIndex = node.attributes.findIndex((a) => a.name === attr.name)
    if (attrNodeIndex === -1) continue
    const attrNode = node.attributes[attrNodeIndex]

    if (attrNode.kind === 'expression' || node.kind === 'shorthand') {
      const start = attrNode.position.start.offset
      // boy if only astro gave us end
      const end =
        (node.attributes[attrNodeIndex + 1]?.position.start.offset ??
          node.children?.[0].position.start.offset ??
          attrNode.name.length + `={}`.length + attrNode.value + 1) - 1
      // foo={foo && bar} -> foo={(foo && bar) || "fallback"}
      // {foo} -> foo={foo || "fallback"}
      s.overwrite(
        start,
        end,
        // prettier-ignore
        `${attrNode.name}={(${attrNode.value || attrNode.name}) || ${parseAttrToString(attr)}}`
      )
    }
  }
}

/**
 * @param {import('@whyframe/core').Attr} attr
 */
function parseAttrToString(attr) {
  if (attr.type === 'dynamic' && typeof attr.value === 'string') {
    return `Astro.props.${attr.value}`
  } else {
    return JSON.stringify(attr.value)
  }
}
