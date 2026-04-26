/**
 * @file 图片附件处理模块。
 *
 * 负责：
 *   1. 解析 `/image <path> [text]` 命令
 *   2. 验证图片格式和大小
 *   3. 读取文件并转为 base64 data URL
 *   4. 构建 OpenAI Vision API 格式的 ContentPart 数组
 */

import { execSync, spawnSync } from 'node:child_process'
import { readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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


// ─── 工具函数 ─────────────────────────────────────────────────────────────────



/**
 * 加载指定路径的图片文件并返回附件对象。
 */
type LoadResult =
    | { ok: true; attachment: ImageAttachment; remainingText: string }
    | { ok: false; error: string }

async function loadImageFile(
    imagePath: string,
    remainingText: string,
): Promise<LoadResult> {
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

// ─── 剪贴板图片读取 ───────────────────────────────────────────────────────────

/**
 * 从系统剪贴板读取图片并返回 ImageAttachment。
 *
 * 跨平台支持：
 *   - macOS:          pngpaste（需预装：brew install pngpaste）
 *   - Windows:        PowerShell + System.Windows.Forms
 *   - Linux Wayland:  wl-paste
 *   - Linux X11:      xclip
 *
 * 剪贴板无图片、工具未安装或读取失败时返回 null。
 */
export async function readClipboardImage(): Promise<ImageAttachment | null> {
    const tmpPath = path.join(tmpdir(), `cclin-img-${Date.now()}.png`)
    try {
        switch (process.platform) {
            case 'darwin':
                execSync(`pngpaste "${tmpPath}"`, { stdio: 'ignore' })
                break
            case 'win32': {
                // 写临时 .ps1 文件，避免 $img/$null 被 shell 插值吃掉
                const psScript = [
                    'Add-Type -AssemblyName System.Windows.Forms',
                    '$img = [System.Windows.Forms.Clipboard]::GetImage()',
                    'if ($null -eq $img) { exit 1 }',
                    `$img.Save('${tmpPath.replace(/\\/g, '\\\\')}')`,
                ].join('\n')
                const psFile = tmpPath + '.ps1'
                const { writeFileSync, unlinkSync } = await import('node:fs')
                writeFileSync(psFile, psScript, 'utf8')
                try {
                    execSync(`powershell -NoProfile -Sta -File "${psFile}"`, { stdio: 'ignore' })
                } finally {
                    try { unlinkSync(psFile) } catch { /* ignore */ }
                }
                break
            }
            default: {
                // Linux: Wayland 优先，回退 X11
                const wayland = spawnSync('wl-paste', ['--type', 'image/png'])
                const imgData = wayland.status === 0 && wayland.stdout.length > 0
                    ? wayland.stdout
                    : (() => {
                        const x11 = spawnSync('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o'])
                        return x11.status === 0 ? x11.stdout : null
                    })()
                if (!imgData || imgData.length === 0) throw new Error('no image data')
                await writeFile(tmpPath, imgData)
            }
        }
    } catch {
        return null
    }

    const result = await loadImageFile(tmpPath, '')
    if (!result.ok) {
        void cleanupTmpFile(tmpPath)
        return null
    }

    // 标记为临时文件路径，供发送后清理
    return result.attachment
}

/**
 * 删除图片临时文件（在 onSubmit 后调用以释放磁盘空间）。
 */
export async function cleanupTmpFile(filePath: string): Promise<void> {
    try {
        await unlink(filePath)
    } catch {
        // ignore — 文件可能已删除
    }
}
