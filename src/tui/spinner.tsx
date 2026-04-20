import React, { useState, useEffect } from 'react'
import { Text } from 'ink'
import spinners from 'unicode-animations'
import type { BrailleSpinnerName } from 'unicode-animations'

export type SpinnerProps = {
    /** 选用的动画效果名称，默认 'braille' */
    name?: BrailleSpinnerName
    /** 动画颜色 */
    color?: string
}

export function Spinner({ name = 'helix', color = 'cyan' }: SpinnerProps) {
    const [frame, setFrame] = useState(0)
    // TypeScript needs to know that `spinners` has `name` key, but `unicode-animations` exports it.
    // If it complains, we'll cast. The typing of `unicode-animations` might be a ES module where default is spinners.
    // Wait, the npm README says `import spinners from 'unicode-animations'` which could mean `default` export.
    const s = spinners[name] || spinners.braille // fallback if not found

    useEffect(() => {
        if (!s) return
        const timer = setInterval(
            () => setFrame(f => (f + 1) % s.frames.length),
            s.interval
        )
        return () => clearInterval(timer)
    }, [name, s])

    if (!s) return <Text color={color}>●</Text>

    return <Text color={color}>{s.frames[frame]}</Text>
}
