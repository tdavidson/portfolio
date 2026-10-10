// The smallest possible DOM builder. The view is plain DOM rather than React: it ships inside
// every `resources/read` response, and React alone is several times the size of everything here.
//
// TEXT IS ALWAYS A TEXT NODE. Company names, investor names, account names and metric labels all
// come from the fund's data. Children are appended as text or as nodes, never parsed as HTML, so
// no value from a payload can become markup. Nothing in the view assigns `innerHTML`.

type Child = Node | string | number | null | undefined | false | Child[]

interface Props {
  class?: string
  [key: string]: unknown
}

function append(parent: Node, child: Child): void {
  if (child === null || child === undefined || child === false) return
  if (Array.isArray(child)) { for (const c of child) append(parent, c); return }
  parent.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child)
}

function setProps(el: Element, props: Props): void {
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue
    if (key === 'class') el.setAttribute('class', String(value))
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value as EventListener)
    else if (key === 'style' && typeof value === 'object') Object.assign((el as HTMLElement).style, value)
    else el.setAttribute(key, value === true ? '' : String(value))
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (props) setProps(el, props)
  append(el, children)
  return el
}

const SVG_NS = 'http://www.w3.org/2000/svg'

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag)
  if (props) setProps(el, props)
  append(el, children)
  return el
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild)
}
