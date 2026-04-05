/**
 * @file Markdown 渲染器 — 将 Markdown 文本解析为 Ink 组件。
 *
 * 自写 parser（正则逐行解析），不依赖外部库。
 * 参考 memo-code/packages/tui/src/chatwidget/MarkdownRenderer.tsx
 *
 * 支持:
 *   - heading (# ## ###)
 *   - paragraph
 *   - code block (```)
 *   - list (- * •)
 *   - blockquote (>)
 *   - horizontal rule (---)
 *   - inline: **bold**, *italic*, `code`, [link](url)
 */

import React, { memo } from 'react'
import { Box, Text } from 'ink'

// ─── Block 解析 ──────────────────────────────────────────────────────────

type MarkdownBlock =
    | { type: 'heading'; level: number; text: string }
    | { type: 'paragraph'; text: string }
    | { type: 'code_block'; lang: string; code: string }
    | { type: 'list_item'; text: string; indent: number }
    | { type: 'blockquote'; text: string }
    | { type: 'table'; headers: string[]; rows: string[][] }
    | { type: 'hr' }

function parseBlocks(raw: string): MarkdownBlock[] {
    const lines = raw.split('\n')
    const blocks: MarkdownBlock[] = []
    let i = 0

    while (i < lines.length) {
        const line = lines[i] ?? ''

        // Code block
        if (line.trimStart().startsWith('```')) {
            const lang = line.trimStart().slice(3).trim()
            const codeLines: string[] = []
            i++
            while (i < lines.length) {
                const cl = lines[i] ?? ''
                if (cl.trimStart().startsWith('```')) { i++; break }
                codeLines.push(cl)
                i++
            }
            blocks.push({ type: 'code_block', lang, code: codeLines.join('\n') })
            continue
        }

        // Horizontal rule
        if (/^-{3,}$/.test(line.trim()) || /^\*{3,}$/.test(line.trim())) {
            blocks.push({ type: 'hr' })
            i++
            continue
        }

        // Heading
        const headingMatch = /^(#{1,3})\s+(.+)/.exec(line)
        if (headingMatch) {
            blocks.push({
                type: 'heading',
                level: (headingMatch[1] ?? '#').length,
                text: headingMatch[2] ?? '',
            })
            i++
            continue
        }

        // Blockquote
        if (line.trimStart().startsWith('> ')) {
            blocks.push({ type: 'blockquote', text: line.replace(/^\s*>\s?/, '') })
            i++
            continue
        }

        // List item
        const listMatch = /^(\s*)[-*•]\s+(.+)/.exec(line)
        if (listMatch) {
            blocks.push({
                type: 'list_item',
                indent: (listMatch[1] ?? '').length,
                text: listMatch[2] ?? '',
            })
            i++
            continue
        }

        // Table (lines starting with |)
        if (/^\s*\|/.test(line)) {
            const tableLines: string[] = []
            while (i < lines.length && /^\s*\|/.test(lines[i] ?? '')) {
                tableLines.push(lines[i]!)
                i++
            }
            // Parse cells: split by |, trim, filter empty
            const dataRows = tableLines
                .filter(l => !/^\s*\|[\s-:|]+\|\s*$/.test(l)) // skip separator rows
                .map(l => l.split('|').map(c => c.trim()).filter(Boolean))
            if (dataRows.length > 0) {
                blocks.push({
                    type: 'table',
                    headers: dataRows[0]!,
                    rows: dataRows.slice(1),
                })
            }
            continue
        }

        // Empty line → skip
        if (line.trim() === '') { i++; continue }

        // Paragraph (collect consecutive non-empty lines)
        const paraLines: string[] = [line]
        i++
        while (i < lines.length) {
            const pl = lines[i] ?? ''
            if (pl.trim() === '' || pl.trimStart().startsWith('#') ||
                pl.trimStart().startsWith('```') || pl.trimStart().startsWith('> ') ||
                /^(\s*)[-*•]\s+/.test(pl) || /^-{3,}$/.test(pl.trim())) break
            paraLines.push(pl)
            i++
        }
        blocks.push({ type: 'paragraph', text: paraLines.join(' ') })
    }

    return blocks
}

// ─── Inline 解析 ─────────────────────────────────────────────────────────

type InlineNode =
    | { type: 'text'; text: string }
    | { type: 'bold'; text: string }
    | { type: 'italic'; text: string }
    | { type: 'code'; text: string }
    | { type: 'link'; text: string; url: string }

function parseInline(raw: string): InlineNode[] {
    const nodes: InlineNode[] = []
    // Combined regex: **bold**, *italic*, `code`, [text](url)
    const re = /\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g
    let lastIndex = 0
    let m: RegExpExecArray | null

    while ((m = re.exec(raw)) !== null) {
        if (m.index > lastIndex) {
            nodes.push({ type: 'text', text: raw.slice(lastIndex, m.index) })
        }
        if (m[1] !== undefined) nodes.push({ type: 'bold', text: m[1] })
        else if (m[2] !== undefined) nodes.push({ type: 'italic', text: m[2] })
        else if (m[3] !== undefined) nodes.push({ type: 'code', text: m[3] })
        else if (m[4] !== undefined && m[5] !== undefined) {
            nodes.push({ type: 'link', text: m[4], url: m[5] })
        }
        lastIndex = m.index + m[0].length
    }

    if (lastIndex < raw.length) {
        nodes.push({ type: 'text', text: raw.slice(lastIndex) })
    }
    return nodes.length > 0 ? nodes : [{ type: 'text', text: raw }]
}

// ─── Ink 渲染组件 ────────────────────────────────────────────────────────

function InlineText({ text }: { text: string }) {
    const nodes = parseInline(text)
    return (
        <Text>
            {nodes.map((n, i) => {
                switch (n.type) {
                    case 'bold': return <Text key={i} bold>{n.text}</Text>
                    case 'italic': return <Text key={i} italic>{n.text}</Text>
                    case 'code': return <Text key={i} color="cyan">`{n.text}`</Text>
                    case 'link': return <Text key={i} color="blue">{n.text}</Text>
                    default: return <Text key={i}>{n.text}</Text>
                }
            })}
        </Text>
    )
}

function BlockRenderer({ block }: { block: MarkdownBlock }) {
    switch (block.type) {
        case 'heading':
            return (
                <Box marginTop={1}>
                    <Text bold color={block.level === 1 ? 'white' : 'gray'}>
                        {'#'.repeat(block.level)} {block.text}
                    </Text>
                </Box>
            )
        case 'code_block':
            return (
                <Box
                    borderStyle="single"
                    borderColor="gray"
                    paddingX={1}
                    marginY={0}
                    flexDirection="column"
                >
                    {block.lang ? <Text color="gray">{block.lang}</Text> : null}
                    <Text color="green">{block.code}</Text>
                </Box>
            )
        case 'list_item': {
            const pad = '  '.repeat(Math.floor(block.indent / 2))
            return (
                <Box>
                    <Text>{pad}• </Text>
                    <InlineText text={block.text} />
                </Box>
            )
        }
        case 'blockquote':
            return (
                <Box>
                    <Text color="gray">│ </Text>
                    <InlineText text={block.text} />
                </Box>
            )
        case 'table': {
            const allRows = [block.headers, ...block.rows]
            const colCount = block.headers.length
            // Calculate column widths
            const colWidths = Array.from({ length: colCount }, (_, ci) =>
                Math.max(3, ...allRows.map(r => (r[ci] ?? '').length)),
            )
            const sep = '┼' + colWidths.map(w => '─'.repeat(w + 2)).join('┼') + '┼'
            const fmtRow = (cells: string[], bold: boolean) => (
                <Text {...(bold ? { bold: true } : {})}>
                    {'│'}{cells.map((c, ci) => ` ${(c ?? '').padEnd(colWidths[ci] ?? 3)} │`).join('')}
                </Text>
            )
            return (
                <Box flexDirection="column">
                    <Text color="gray">{sep}</Text>
                    {fmtRow(block.headers, true)}
                    <Text color="gray">{sep}</Text>
                    {block.rows.map((row, ri) => (
                        <Box key={ri} flexDirection="column">
                            {fmtRow(row, false)}
                        </Box>
                    ))}
                    <Text color="gray">{sep}</Text>
                </Box>
            )
        }
        case 'hr':
            return <Text color="gray">{'─'.repeat(40)}</Text>
        case 'paragraph':
            return <InlineText text={block.text} />
    }
}

// ─── 导出组件 ─────────────────────────────────────────────────────────────

export const MarkdownRenderer = memo(function MarkdownRenderer({
    content,
}: {
    content: string
}) {
    const blocks = parseBlocks(content)
    return (
        <Box flexDirection="column">
            {blocks.map((block, i) => (
                <BlockRenderer key={i} block={block} />
            ))}
        </Box>
    )
})
