/**
 * @file 图片附件处理模块。
 *
 * 负责：
 *   1. 解析 `/image <path> [text]` 命令
 *   2. 验证图片格式和大小
 *   3. 读取文件并转为 base64 data URL
 *   4. 构建 OpenAI Vision API 格式的 ContentPart 数组
 */

import { readFile } from 'node:fs/promises'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { ContentPart } from '../types.js'

// ─── 常量 ─────────────────────────────────────────────────────────────────────

/** 支持的图片 MIME 类型映射。 */
const MIME_MAP: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
}

/** 单张图片最大文件大小（20 MB，对应 OpenAI Vision 限制）。 */
const MAX_SIZE_BYTES = 20 * 1024 * 1024

// ─── 类型 ─────────────────────────────────────────────────────────────────────

/** 已加载的图片附件信息。 */
export type ImageAttachment = {
    /** 原始文件路径（用于 UI 显示）。 */
    path: string
    /** 文件名（basename，用于显示）。 */
    filename: string
    /** base64 编码的图片数据（不含 data URL 前缀）。 */
    base64: string
    /** MIME 类型。 */
    mimeType: string
    /** 文件大小（KB）。 */
    sizeKB: number
}

/** 解析 /image 命令的结果。 */
export type ParseImageCommandResult =
    | { ok: true; attachment: ImageAttachment; remainingText: string }
    | { ok: false; error: string }

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

/**
 * 解析 `/image <path> [剩余文本]` 命令。
 *
 * 支持带引号的路径（处理含空格的路径）：
 *   /image "C:\My Pics\a.png" 描述文字
 *   /image ./screenshot.png  （无引号，到第一个空格为止）
 */
export async function parseImageCommand(
    input: string,
): Promise<ParseImageCommandResult> {
    const trimmed = input.trim()
    if (!trimmed.startsWith('/image')) {
        return { ok: false, error: 'Not an /image command' }
    }

    // 去掉 "/image" 前缀，取剩余部分
    const rest = trimmed.slice('/image'.length).trim()
    if (!rest) {
        return { ok: false, error: 'Usage: /image <path> [description]' }
    }

    let imagePath: string
    let remainingText: string

    if (rest.startsWith('"')) {
        // 带引号路径
        const closeQuote = rest.indexOf('"', 1)
        if (closeQuote === -1) {
            return { ok: false, error: 'Unclosed quote in image path' }
        }
        imagePath = rest.slice(1, closeQuote)
        remainingText = rest.slice(closeQuote + 1).trim()
    } else {
        // 无引号：路径到第一个空格为止
        const spaceIdx = rest.search(/\s/)
        if (spaceIdx === -1) {
            imagePath = rest
            remainingText = ''
        } else {
            imagePath = rest.slice(0, spaceIdx)
            remainingText = rest.slice(spaceIdx).trim()
        }
    }

    return loadImageFile(imagePath, remainingText)
}

/**
 * 加载指定路径的图片文件并返回附件对象。
 */
async function loadImageFile(
    imagePath: string,
    remainingText: string,
): Promise<ParseImageCommandResult> {
    // 解析扩展名
    const ext = path.extname(imagePath).toLowerCase()
    const mimeType = MIME_MAP[ext]
    if (!mimeType) {
        const supported = Object.keys(MIME_MAP).join(', ')
        return {
            ok: false,
            error: `Unsupported image format "${ext}". Supported: ${supported}`,
        }
    }

    // 检查文件存在和大小
    let fileSize: number
    try {
        const info = await stat(imagePath)
        if (!info.isFile()) {
            return { ok: false, error: `"${imagePath}" is not a file` }
        }
        fileSize = info.size
    } catch {
        return { ok: false, error: `File not found: "${imagePath}"` }
    }

    if (fileSize > MAX_SIZE_BYTES) {
        const sizeMB = (fileSize / 1024 / 1024).toFixed(1)
        return {
            ok: false,
            error: `Image too large (${sizeMB} MB). Maximum allowed: 20 MB`,
        }
    }

    // 读取并转 base64
    let base64: string
    try {
        const buf = await readFile(imagePath)
        base64 = buf.toString('base64')
    } catch (err) {
        return { ok: false, error: `Failed to read file: ${(err as Error).message}` }
    }

    const attachment: ImageAttachment = {
        path: imagePath,
        filename: path.basename(imagePath),
        base64,
        mimeType,
        sizeKB: Math.round(fileSize / 1024),
    }

    return { ok: true, attachment, remainingText }
}

/**
 * 构建 OpenAI Vision API 格式的多模态 ContentPart 数组。
 *
 * 顺序：文字在前，图片在后（与 Claude/OpenAI 推荐顺序一致）。
 */
export function buildMultimodalContent(
    text: string,
    attachments: ImageAttachment[],
): ContentPart[] {
    const parts: ContentPart[] = []

    if (text.trim()) {
        parts.push({ type: 'text', text })
    }

    for (const att of attachments) {
        parts.push({
            type: 'image_url',
            image_url: {
                url: `data:${att.mimeType};base64,${att.base64}`,
                detail: 'auto',
            },
        })
    }

    return parts
}

/**
 * 将 UserContent（string | ContentPart[]）提取为纯文本（用于日志、历史序列化）。
 *
 * 非文本块会被替换为 `[image: filename]` 占位符。
 */
export function extractTextFromContent(
    content: string | ContentPart[],
    attachments?: ImageAttachment[],
): string {
    if (typeof content === 'string') return content
    return content
        .map((part, i) => {
            if (part.type === 'text') return part.text
            // 图片块：尽量显示文件名
            const att = attachments?.[i]
            return att ? `[image: ${att.filename}]` : '[image]'
        })
        .join('\n')
        .trim()
}
