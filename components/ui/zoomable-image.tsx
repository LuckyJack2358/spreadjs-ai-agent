"use client"

// ============================================================================
// 可点击放大的缩略图
//   点击缩略图 → Dialog 内以 object-contain 展示原图（默认占屏约 60vh）
//   可选 sideContent 在放大图右侧渲染对照内容（例如识别字段清单），
//   便于把线下单据原图与识别结果逐项比对。
// ============================================================================

import { useState, type ReactNode } from "react"
import Image from "next/image"
import { ZoomInIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

interface ZoomableImageProps {
  src: string
  alt: string
  /** 缩略图容器的尺寸类（例如 size-20 / size-24） */
  className?: string
  /** 弹窗标题，默认取 alt */
  title?: string
  /** 弹窗副标题说明 */
  description?: string
  /** 放大图右侧的对照内容 */
  sideContent?: ReactNode
}

export function ZoomableImage({
  src,
  alt,
  className,
  title,
  description,
  sideContent,
}: ZoomableImageProps) {
  const [open, setOpen] = useState(false)
  // 有对照内容时放大图与清单并排（md 起）
  const rowLayout = Boolean(sideContent)

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="点击放大查看（与识别结果对照）"
        aria-label={`放大查看：${title ?? alt}`}
        className={cn(
          "group relative block shrink-0 cursor-zoom-in overflow-hidden rounded-md border border-border/60 bg-muted/30",
          className
        )}
      >
        <Image
          src={src}
          alt={alt}
          fill
          unoptimized
          sizes="240px"
          className="object-cover"
        />
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
          <ZoomInIcon className="size-4 text-white" />
        </span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[95vw] gap-3 sm:max-w-[95vw]">
          <DialogHeader>
            <DialogTitle className="text-base">{title ?? alt}</DialogTitle>
            <DialogDescription className="text-xs">
              {description ?? "放大查看单据原图，可与识别结果逐项对照。"}
            </DialogDescription>
          </DialogHeader>
          <div className={cn("flex flex-col gap-3", rowLayout ? "md:flex-row" : undefined)}>
            {/* 注意：flex-1 只能在并排（md:flex-row）时用。在 flex-col 里 flex-basis:0%
                会覆盖 h-[58vh]（flex 主轴尺寸优先于 height），图片区会塌陷成 0 高。 */}
            <div
              className={cn(
                "relative h-[58vh] w-full min-w-0 overflow-hidden rounded-md border border-border/60 bg-muted/30 md:h-[68vh]",
                rowLayout ? "md:flex-1" : undefined
              )}
            >
              <Image
                src={src}
                alt={alt}
                fill
                unoptimized
                sizes="95vw"
                className="object-contain"
              />
            </div>
            {sideContent ? (
              <div className="w-full shrink-0 overflow-y-auto pr-1 md:max-h-[68vh] md:w-[320px]">
                {sideContent}
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
