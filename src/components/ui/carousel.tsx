import * as React from "react"
import useEmblaCarousel, {
  type UseEmblaCarouselType,
} from "embla-carousel-react"
import { ArrowLeft, ArrowRight } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/lib/i18n"
import {
  INTERACTIVE_MEDIA_SELECTOR,
  carouselArrowDirection,
  shouldCarouselHandleKey,
} from "@/lib/media-ux-copy"

type CarouselApi = UseEmblaCarouselType[1]
type UseCarouselParameters = Parameters<typeof useEmblaCarousel>
type CarouselOptions = UseCarouselParameters[0]
type CarouselPlugin = UseCarouselParameters[1]

type CarouselProps = {
  opts?: CarouselOptions
  plugins?: CarouselPlugin
  orientation?: "horizontal" | "vertical"
  keyboardNavigation?: boolean
  inertOffscreenSlides?: boolean
  setApi?: (api: CarouselApi) => void
}

type CarouselContextProps = {
  carouselRef: ReturnType<typeof useEmblaCarousel>[0]
  api: ReturnType<typeof useEmblaCarousel>[1]
  scrollPrev: () => void
  scrollNext: () => void
  canScrollPrev: boolean
  canScrollNext: boolean
  slidesInView: number[]
  inertOffscreenSlides: boolean
} & CarouselProps

const CarouselContext = React.createContext<CarouselContextProps | null>(null)

function useCarousel() {
  const context = React.useContext(CarouselContext)

  if (!context) {
    throw new Error("useCarousel must be used within a <Carousel />")
  }

  return context
}

const Carousel = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & CarouselProps
>(
  (
    {
      orientation,
      keyboardNavigation = true,
      inertOffscreenSlides = false,
      opts,
      setApi,
      plugins,
      className,
      children,
      ...props
    },
    ref
  ) => {
    const effectiveOrientation: "horizontal" | "vertical" =
      orientation ?? (opts?.axis === "y" ? "vertical" : "horizontal")
    const [carouselRef, api] = useEmblaCarousel(
      {
        ...(inertOffscreenSlides ? { inViewThreshold: 0.5 } : {}),
        ...opts,
        axis: effectiveOrientation === "horizontal" ? "x" : "y",
      },
      plugins
    )
    const [canScrollPrev, setCanScrollPrev] = React.useState(false)
    const [canScrollNext, setCanScrollNext] = React.useState(false)
    const [slidesInView, setSlidesInView] = React.useState<number[]>([0])

    const onSelect = React.useCallback((currentApi: CarouselApi) => {
      if (!currentApi) {
        return
      }

      setCanScrollPrev(currentApi.canScrollPrev())
      setCanScrollNext(currentApi.canScrollNext())
      const inView = currentApi.slidesInView()
      setSlidesInView(
        inView.length > 0 ? inView : [currentApi.selectedScrollSnap()]
      )
    }, [])

    const onSlidesInView = React.useCallback((currentApi: CarouselApi) => {
      if (!currentApi) return
      const inView = currentApi.slidesInView()
      if (inView.length > 0) setSlidesInView(inView)
    }, [])

    const scrollPrev = React.useCallback(() => {
      api?.scrollPrev()
    }, [api])

    const scrollNext = React.useCallback(() => {
      api?.scrollNext()
    }, [api])

    const handleKeyDown = React.useCallback(
      (event: React.KeyboardEvent<HTMLDivElement>) => {
        const direction = carouselArrowDirection(event.key, effectiveOrientation)
        if (!direction) return
        const target = event.target instanceof Element ? event.target : null
        const canHandle = shouldCarouselHandleKey({
          keyboardNavigation,
          defaultPrevented: event.defaultPrevented,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          isCarouselRoot: event.target === event.currentTarget,
          isCarouselNav: Boolean(target?.closest("[data-carousel-nav]")),
          inInteractiveControl: Boolean(target?.closest(INTERACTIVE_MEDIA_SELECTOR)),
        })
        if (!canHandle) return
        event.preventDefault()
        if (direction === "prev") scrollPrev()
        else scrollNext()
      },
      [effectiveOrientation, keyboardNavigation, scrollPrev, scrollNext]
    )

    React.useEffect(() => {
      if (!api || !setApi) {
        return
      }

      setApi(api)
    }, [api, setApi])

    React.useEffect(() => {
      if (!api) {
        return
      }

      onSelect(api)
      api.on("reInit", onSelect)
      api.on("select", onSelect)
      api.on("settle", onSlidesInView)
      api.on("slidesInView", onSlidesInView)

      return () => {
        api?.off("select", onSelect)
        api?.off("reInit", onSelect)
        api?.off("settle", onSlidesInView)
        api?.off("slidesInView", onSlidesInView)
      }
    }, [api, onSelect, onSlidesInView])

    return (
      <CarouselContext.Provider
        value={{
          carouselRef,
          api: api,
          opts,
          orientation: effectiveOrientation,
          scrollPrev,
          scrollNext,
          canScrollPrev,
          canScrollNext,
          slidesInView,
          inertOffscreenSlides,
        }}
      >
        <div
          ref={ref}
          onKeyDown={handleKeyDown}
          className={cn("relative", className)}
          role="region"
          aria-roledescription="carousel"
          {...props}
        >
          {children}
        </div>
      </CarouselContext.Provider>
    )
  }
)
Carousel.displayName = "Carousel"

const CarouselContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => {
  const { carouselRef, orientation } = useCarousel()

  return (
    <div ref={carouselRef} className="overflow-hidden">
      <div
        ref={ref}
        className={cn(
          "flex",
          orientation === "horizontal" ? "-ml-4" : "-mt-4 flex-col",
          className
        )}
        {...props}
      />
    </div>
  )
})
CarouselContent.displayName = "CarouselContent"

const CarouselItem = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { slideIndex?: number }
>(({ className, slideIndex, inert, "aria-hidden": ariaHidden, ...props }, ref) => {
  const { orientation, inertOffscreenSlides, slidesInView } = useCarousel()
  const offscreen =
    inertOffscreenSlides &&
    slideIndex !== undefined &&
    slidesInView.length > 0 &&
    !slidesInView.includes(slideIndex)
  const resolvedInert = inert ?? (offscreen || undefined)
  const resolvedAriaHidden = ariaHidden ?? (offscreen || undefined)

  return (
    <div
      ref={ref}
      role="group"
      aria-roledescription="slide"
      inert={resolvedInert}
      aria-hidden={resolvedAriaHidden}
      className={cn(
        "min-w-0 shrink-0 grow-0 basis-full",
        orientation === "horizontal" ? "pl-4" : "pt-4",
        className
      )}
      {...props}
    />
  )
})
CarouselItem.displayName = "CarouselItem"

const CarouselPrevious = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<typeof Button>
>(({ className, variant = "outline", size = "icon", ...props }, ref) => {
  const { t } = useI18n()
  const { orientation, scrollPrev, canScrollPrev } = useCarousel()

  return (
    <Button
      ref={ref}
      data-carousel-nav="true"
      variant={variant}
      size={size}
      className={cn(
        "absolute  h-8 w-8 rounded-full",
        orientation === "horizontal"
          ? "-left-12 top-1/2 -translate-y-1/2"
          : "-top-12 left-1/2 -translate-x-1/2 rotate-90",
        className
      )}
      disabled={!canScrollPrev}
      onClick={scrollPrev}
      {...props}
    >
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      <span className="sr-only">{t("previousSlide")}</span>
    </Button>
  )
})
CarouselPrevious.displayName = "CarouselPrevious"

const CarouselNext = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<typeof Button>
>(({ className, variant = "outline", size = "icon", ...props }, ref) => {
  const { t } = useI18n()
  const { orientation, scrollNext, canScrollNext } = useCarousel()

  return (
    <Button
      ref={ref}
      data-carousel-nav="true"
      variant={variant}
      size={size}
      className={cn(
        "absolute h-8 w-8 rounded-full",
        orientation === "horizontal"
          ? "-right-12 top-1/2 -translate-y-1/2"
          : "-bottom-12 left-1/2 -translate-x-1/2 rotate-90",
        className
      )}
      disabled={!canScrollNext}
      onClick={scrollNext}
      {...props}
    >
      <ArrowRight className="h-4 w-4" aria-hidden="true" />
      <span className="sr-only">{t("nextSlide")}</span>
    </Button>
  )
})
CarouselNext.displayName = "CarouselNext"

export {
  type CarouselApi,
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselPrevious,
  CarouselNext,
}
