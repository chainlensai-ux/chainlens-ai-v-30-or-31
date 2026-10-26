'use client'

import { Fragment } from 'react'
import { parseClarkInline, parseClarkReply, type ClarkReplyBlock } from '@/lib/client/clarkReplyFormat'

// Renders one Clark reply as readable sections (see lib/client/clarkReplyFormat.ts). Presentation
// only: the text shown is exactly the text Clark returned; verdict/confidence chips are coloured
// from the words in the reply itself, never from a score computed here. Styles live in
// app/terminal/clark-ai/clarkAiPageCss.ts (.clk-r-*).

function Inline({ text }: { text: string }) {
  return (
    <>
      {parseClarkInline(text).map((p, i) => {
        if (p.kind === 'strong') return <strong key={i}>{p.text}</strong>
        if (p.kind === 'code') return <code key={i} className='clk-r-code'>{p.text}</code>
        if (p.kind === 'address') return <span key={i} className='clk-r-addr'>{p.text}</span>
        if (p.kind === 'link') return <a key={i} className='clk-r-link' href={p.href} target='_blank' rel='noopener noreferrer'>{p.text}</a>
        return <Fragment key={i}>{p.text}</Fragment>
      })}
    </>
  )
}

/** "Token scan: ok" inside a bullet → bold label, plain value. Only for short labels. */
function ListItem({ text }: { text: string }) {
  const m = text.match(/^([A-Z][A-Za-z0-9 /&'()-]{1,30}):\s+(\S.*)$/)
  if (!m || /https?$/i.test(m[1])) return <li><Inline text={text} /></li>
  return <li><span className='clk-r-key'>{m[1]}:</span> <Inline text={m[2]} /></li>
}

function Block({ block }: { block: ClarkReplyBlock }) {
  switch (block.kind) {
    case 'verdict':
      return (
        <div className='clk-r-verdict'>
          <span className='clk-r-verdict-label'>{block.label}</span>
          <span className={`clk-r-chip clk-r-chip--${block.tone}`}><Inline text={block.value} /></span>
        </div>
      )
    case 'field':
      return <p className='clk-r-field'><span className='clk-r-key'>{block.label}:</span> <Inline text={block.value} /></p>
    case 'heading':
      return <h4 className={`clk-r-h clk-r-h--${block.tone}`}>{block.text}</h4>
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul'
      return <Tag className='clk-r-list'>{block.items.map((item, i) => <ListItem key={i} text={item} />)}</Tag>
    }
    case 'disclaimer':
      return <p className='clk-r-disclaimer'><Inline text={block.text} /></p>
    case 'paragraph':
      return <p className='clk-r-p'><Inline text={block.text} /></p>
  }
}

export default function ClarkReply({ text }: { text: string }) {
  const blocks = parseClarkReply(text)
  // Consecutive verdict/confidence lines sit together in one row.
  const out: Array<ClarkReplyBlock | ClarkReplyBlock[]> = []
  for (const b of blocks) {
    const prev = out[out.length - 1]
    if (b.kind === 'verdict' && Array.isArray(prev)) prev.push(b)
    else out.push(b.kind === 'verdict' ? [b] : b)
  }
  return (
    <div className='clk-r'>
      {out.map((b, i) => Array.isArray(b)
        ? <div key={i} className='clk-r-verdicts'>{b.map((v, j) => <Block key={j} block={v} />)}</div>
        : <Block key={i} block={b} />)}
    </div>
  )
}
