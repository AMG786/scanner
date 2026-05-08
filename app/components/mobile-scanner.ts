import { action } from "@ember/object"
import Component from "@glimmer/component"
import { tracked } from "@glimmer/tracking"

interface MobileScannerArgs {
	onScan: (file: File) => void
	onClose: () => void
}

export default class MobileScannerComponent extends Component<MobileScannerArgs> {
	@tracked isCameraOpen = false
	@tracked capturedImages: string[] = []
	@tracked isGenerating = false
	@tracked isProcessingImage = false
	@tracked libsReady = false
	@tracked libsLoading = false
	@tracked cameraError: string | null = null

	static MAX_PAGES = 20

	private static A4_W = 794
	private static A4_H = 1123

	private stream: MediaStream | null = null
	private scanner: any = null
	private highlightInterval: ReturnType<typeof setInterval> | null = null
	private highlightCanvas: HTMLCanvasElement | null = null
	private videoElement: HTMLVideoElement | null = null

	get capturedImagesWithIndex() {
		return this.capturedImages.map((url, index) => ({
			url,
			index,
			pageNumber: index + 1,
		}))
	}

	get isAtPageLimit() {
		return this.capturedImages.length >= MobileScannerComponent.MAX_PAGES
	}

	// ── iOS detection ──────────────────────────────────────────────────

	private get isIOS(): boolean {
		return (
			/iPad|iPhone|iPod/.test(navigator.userAgent) ||
			// iPad OS 13+ reports as MacIntel with touch support
			(navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
		)
	}

	// ── Library loading ────────────────────────────────────────────────

	private loadScript(src: string): Promise<void> {
		return new Promise((resolve, reject) => {
			if (document.querySelector(`script[src="${src}"]`)) {
				resolve()
				return
			}
			const script = document.createElement("script")
			script.src = src
			script.onload = () => resolve()
			script.onerror = () => reject(new Error(`Failed to load ${src}`))
			document.head.appendChild(script)
		})
	}

	private waitForOpenCV(): Promise<void> {
		return new Promise((resolve, reject) => {
			// iOS Safari has stricter Wasm init time — give it 15s
			const timeout = setTimeout(() => {
				reject(new Error("OpenCV timed out"))
			}, 15000)

			const check = () => {
				// biome-ignore lint/suspicious/noExplicitAny: opencv global
				const cv = (window as any).cv
				if (cv && cv.Mat) {
					clearTimeout(timeout)
					resolve()
				} else if (cv && cv.onRuntimeInitialized !== undefined) {
					cv.onRuntimeInitialized = () => {
						clearTimeout(timeout)
						resolve()
					}
				} else {
					setTimeout(check, 100)
				}
			}
			check()
		})
	}

	private async loadScannerLibs(): Promise<void> {
		if (this.libsReady) return
		if (this.libsLoading) return
		this.libsLoading = true
		try {
			await this.loadScript("https://docs.opencv.org/4.x/opencv.js")
			await this.waitForOpenCV()
			await this.loadScript(
				"https://cdn.jsdelivr.net/gh/ColonelParrot/jscanify@master/src/jscanify.min.js",
			)
			// biome-ignore lint/suspicious/noExplicitAny: jscanify global
			this.scanner = new (window as any).jscanify()
			this.libsReady = true
		} catch (e) {
			console.warn("Scanner libs failed to load, will use raw capture:", e)
			// Camera still works — just no outline highlight
		} finally {
			this.libsLoading = false
		}
	}

	// ── Camera ─────────────────────────────────────────────────────────

	@action async openCamera() {
		if (this.isAtPageLimit) return
		this.cameraError = null

		// Start loading libs in background — don't block camera open
		this.loadScannerLibs().catch(() => {/* handled inside */})

		try {
			// iOS Safari is strict about constraints.
			// Use `ideal` (never `exact`) to avoid OverconstrainedError.
			// Keep it simple on iOS — extra constraints trigger silent failures.
			const constraints: MediaStreamConstraints = {
				video: {
					facingMode: { ideal: "environment" },
					...(this.isIOS
						? {} // iOS picks its own resolution — don't hint
						: { width: { ideal: 1920 }, height: { ideal: 1080 } }),
				},
			}

			this.stream = await navigator.mediaDevices.getUserMedia(constraints)
			this.isCameraOpen = true
		} catch (err: any) {
			const msg =
				err?.name === "NotAllowedError"
					? "Camera access denied. Please allow camera access in your browser settings and try again."
					: err?.name === "NotFoundError"
						? "No camera found on this device."
						: `Could not start camera: ${err?.message ?? "unknown error"}`
			this.cameraError = msg
		}
	}

	@action setupVideoElement(videoEl: HTMLVideoElement) {
		this.videoElement = videoEl

		if (!this.stream) return

		// On iOS, these MUST be set as both attributes AND properties.
		// The HBS attributes alone are sometimes ignored before srcObject is set.
		videoEl.setAttribute("autoplay", "")
		videoEl.setAttribute("muted", "")
		videoEl.setAttribute("playsinline", "") // prevents iOS fullscreen takeover
		videoEl.muted = true      // property needed alongside attribute for iOS
		videoEl.playsInline = true

		videoEl.srcObject = this.stream

		// iOS requires play() to be called after metadata loads.
		// It also must originate (indirectly) from a user gesture — openCamera()
		// is called from a button click, so this chain is safe.
		videoEl.addEventListener(
			"loadedmetadata",
			() => {
				videoEl.play().catch((e) => {
					console.warn("video.play() failed:", e)
				})
			},
			{ once: true },
		)
	}

	/**
	 * Pre-processes a canvas frame before passing it to jscanify's highlightPaper.
	 *
	 * iPhone's True Tone / auto white balance washes out warm-coloured borders
	 * (yellow, cream, light grey) making them near-invisible to OpenCV's edge
	 * detector. This method boosts saturation and contrast on a cheap off-screen
	 * canvas so the border produces strong edges, without altering the live
	 * preview the user sees.
	 *
	 * Only applied on iOS — Android detection works fine with the raw frame.
	 */
	private preprocessFrameForDetection(source: HTMLCanvasElement): HTMLCanvasElement {
		if (!this.isIOS) return source

		const w = source.width
		const h = source.height
		const tmp = document.createElement("canvas")
		tmp.width = w
		tmp.height = h
		const ctx = tmp.getContext("2d", { willReadFrequently: true })
		if (!ctx) return source

		ctx.drawImage(source, 0, 0)

		let imageData: ImageData
		try {
			imageData = ctx.getImageData(0, 0, w, h)
		} catch {
			return source // tainted canvas — skip
		}

		const data = imageData.data

		// Boost saturation (1.0 = no change, 2.5 = vivid) and contrast so that
		// even a faint yellow border becomes a crisp edge for OpenCV to find.
		const SATURATION = 2.5
		const CONTRAST   = 1.6
		const BRIGHTNESS = 10 // slight lift so mid-tones don't go too dark

		for (let i = 0; i < data.length; i += 4) {
			let r = data[i]     ?? 0
			let g = data[i + 1] ?? 0
			let b = data[i + 2] ?? 0

			// ── Saturation boost in HSL space ──────────────────────────
			const max = Math.max(r, g, b) / 255
			const min = Math.min(r, g, b) / 255
			const l   = (max + min) / 2

			if (max !== min) {
				const d  = max - min
				const s  = l > 0.5 ? d / (2 - max - min) : d / (max + min)
				// Re-apply with boosted saturation
				const newS = Math.min(s * SATURATION, 1)
				const q    = l < 0.5 ? l * (1 + newS) : l + newS - l * newS
				const p    = 2 * l - q
				const hue  = max === (r / 255)
					? (g / 255 - b / 255) / d + (g < b ? 6 : 0)
					: max === (g / 255)
						? (b / 255 - r / 255) / d + 2
						: (r / 255 - g / 255) / d + 4

				const h6 = hue / 6
				const hue2rgb = (p2: number, q2: number, t: number): number => {
					const tt = ((t % 1) + 1) % 1
					if (tt < 1 / 6) return p2 + (q2 - p2) * 6 * tt
					if (tt < 1 / 2) return q2
					if (tt < 2 / 3) return p2 + (q2 - p2) * (2 / 3 - tt) * 6
					return p2
				}
				r = Math.round(hue2rgb(p, q, h6 + 1 / 3) * 255)
				g = Math.round(hue2rgb(p, q, h6) * 255)
				b = Math.round(hue2rgb(p, q, h6 - 1 / 3) * 255)
			}

			// ── Contrast + brightness ───────────────────────────────────
			r = Math.max(0, Math.min(255, (r - 128) * CONTRAST + 128 + BRIGHTNESS))
			g = Math.max(0, Math.min(255, (g - 128) * CONTRAST + 128 + BRIGHTNESS))
			b = Math.max(0, Math.min(255, (b - 128) * CONTRAST + 128 + BRIGHTNESS))

			data[i]     = r
			data[i + 1] = g
			data[i + 2] = b
		}

		ctx.putImageData(imageData, 0, 0)
		return tmp
	}

	@action setupHighlightCanvas(canvas: HTMLCanvasElement) {
		this.highlightCanvas = canvas

		// willReadFrequently tells Safari to keep the canvas in CPU memory,
		// avoiding expensive GPU readbacks on every getImageData call.
		const ctx = canvas.getContext("2d", { willReadFrequently: true })
		if (!ctx) return

		const startLoop = () => {
			const video = this.videoElement
			if (!video) return

			// 150ms (~6fps) is more reliable on iOS than 100ms —
			// Safari throttles background/low-power tabs aggressively.
			this.highlightInterval = setInterval(() => {
				if (!video.videoWidth || !video.videoHeight) return

				if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth
				if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight

				try {
					ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
				} catch {
					// drawImage throws if video isn't ready — skip frame
					return
				}

				if (this.scanner) {
					try {
						// On iOS, pre-process to boost colour edges before detection.
						// The result is only used for jscanify — the canvas shown to
						// the user still receives the original highlighted outline drawn
						// back over it, so the preview never looks over-saturated.
						const frameForDetection = this.preprocessFrameForDetection(canvas)
						const highlighted = this.scanner.highlightPaper(frameForDetection)
						ctx.clearRect(0, 0, canvas.width, canvas.height)
						// Draw the original video frame first (natural colours for user)
						ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
						// Then draw only the highlight overlay from jscanify on top
						ctx.drawImage(highlighted, 0, 0)
					} catch {
						// No document detected — show raw frame, that's fine
					}
				}
			}, 150)
		}

		// The video element may not yet be set when the canvas inserts into DOM.
		// Poll briefly, then fall back to the `playing` event.
		const waitForVideo = () => {
			const video = this.videoElement
			if (video && video.readyState >= 2) {
				startLoop()
			} else if (video) {
				video.addEventListener("playing", startLoop, { once: true })
			} else {
				setTimeout(waitForVideo, 50)
			}
		}
		waitForVideo()
	}

	@action async capturePhoto() {
		if (this.isAtPageLimit) return

		const canvas = this.highlightCanvas
		if (!canvas) return

		if (this.highlightInterval !== null) {
			clearInterval(this.highlightInterval)
			this.highlightInterval = null
		}

		this.isProcessingImage = true

		try {
			let scanned: HTMLCanvasElement

			if (this.scanner && this.libsReady) {
				scanned = this.scanner.extractPaper(
					canvas,
					MobileScannerComponent.A4_W,
					MobileScannerComponent.A4_H,
				)
			} else {
				// Fallback: copy current frame to a fresh canvas
				scanned = document.createElement("canvas")
				scanned.width = canvas.width
				scanned.height = canvas.height
				scanned
					.getContext("2d", { willReadFrequently: true })
					?.drawImage(canvas, 0, 0)
			}

			const enhanced = this.enhanceImage(scanned)
			this.capturedImages = [
				...this.capturedImages,
				enhanced.toDataURL("image/jpeg", 0.85),
			]
		} catch (_e) {
			console.error("Capture error:", _e)
			try {
				// Last-resort: raw frame
				this.capturedImages = [
					...this.capturedImages,
					canvas.toDataURL("image/jpeg", 0.7),
				]
			} catch {
				// Canvas may be tainted (cross-origin) — tell the user
				this.cameraError = "Could not capture image. Please try again."
			}
		} finally {
			this.isProcessingImage = false
			this.stopCamera()
		}
	}

	// ── File input ─────────────────────────────────────────────────────

	@action loadFromFile() {
		const input = document.getElementById("scanner-file-input") as HTMLInputElement
		if (input) input.click()
	}

	@action async processFileInput(e: Event) {
		const file = (e.target as HTMLInputElement).files?.[0]
		if (!file) return

		this.isProcessingImage = true

		try {
			const dataUrl = await new Promise<string>((resolve) => {
				const reader = new FileReader()
				reader.onload = (ev) => resolve(ev.target?.result as string)
				reader.readAsDataURL(file)
			})

			const img = new Image()
			// crossOrigin must be set before src on iOS
			img.crossOrigin = "anonymous"
			await new Promise<void>((resolve, reject) => {
				img.onload = () => resolve()
				img.onerror = () => reject(new Error("Image load failed"))
				img.src = dataUrl
			})

			await this.loadScannerLibs()

			let scanned: HTMLCanvasElement

			if (this.scanner && this.libsReady) {
				scanned = this.scanner.extractPaper(
					img,
					MobileScannerComponent.A4_W,
					MobileScannerComponent.A4_H,
				)
			} else {
				const fallback = document.createElement("canvas")
				fallback.width = img.naturalWidth || img.width
				fallback.height = img.naturalHeight || img.height
				fallback
					.getContext("2d", { willReadFrequently: true })!
					.drawImage(img, 0, 0)
				scanned = fallback
			}

			const enhanced = this.enhanceImage(scanned)
			this.capturedImages = [
				...this.capturedImages,
				enhanced.toDataURL("image/jpeg", 0.85),
			]
		} catch (_e) {
			console.error("Failed to process file:", _e)
		} finally {
			this.isProcessingImage = false
			const input = document.getElementById(
				"scanner-file-input",
			) as HTMLInputElement
			if (input) input.value = ""
		}
	}

	// ── Stop camera ────────────────────────────────────────────────────

	@action stopCamera() {
		if (this.highlightInterval !== null) {
			clearInterval(this.highlightInterval)
			this.highlightInterval = null
		}
		this.highlightCanvas = null
		this.videoElement = null
		if (this.stream) {
			this.stream.getTracks().forEach((track) => track.stop())
			this.stream = null
		}
		this.isCameraOpen = false
	}

	@action removePage(index: number) {
		this.capturedImages = this.capturedImages.filter((_, i) => i !== index)
	}

	// ── Image enhancement ──────────────────────────────────────────────

	/**
	 * Adaptive threshold enhancement.
	 *
	 * 1. Estimates local background brightness per tile (90th percentile).
	 * 2. Bilinearly interpolates to produce a smooth background map.
	 * 3. Normalises each pixel against its local background → paper → white.
	 * 4. Contrast stretch + white-point clamp → ink stays dark, paper goes pure white.
	 *
	 * All canvas operations are wrapped in try/catch — iOS throws SecurityError
	 * if the canvas is tainted by cross-origin content.
	 */
	private enhanceImage(canvas: HTMLCanvasElement): HTMLCanvasElement {
		const out = document.createElement("canvas")
		out.width = canvas.width
		out.height = canvas.height

		const ctx = out.getContext("2d", { willReadFrequently: true })
		if (!ctx) return canvas

		try {
			ctx.drawImage(canvas, 0, 0)
		} catch {
			return canvas
		}

		let imageData: ImageData
		try {
			imageData = ctx.getImageData(0, 0, out.width, out.height)
		} catch {
			// SecurityError — canvas is tainted on iOS
			return canvas
		}

		const data = imageData.data
		const w = out.width
		const h = out.height

		// Greyscale luminance map
		const grey = new Float32Array(w * h)
		for (let i = 0; i < w * h; i++) {
			const r = data[i * 4] ?? 0
			const g = data[i * 4 + 1] ?? 0
			const b = data[i * 4 + 2] ?? 0
			grey[i] = 0.299 * r + 0.587 * g + 0.114 * b
		}

		// Tile-based background estimation (90th percentile = paper brightness)
		const TILES = 8
		const tileW = Math.ceil(w / TILES)
		const tileH = Math.ceil(h / TILES)
		const bg = new Float32Array((TILES + 1) * (TILES + 1))

		for (let ty = 0; ty <= TILES; ty++) {
			for (let tx = 0; tx <= TILES; tx++) {
				const x0 = Math.min(tx * tileW, w - 1)
				const y0 = Math.min(ty * tileH, h - 1)
				const x1 = Math.min(x0 + tileW, w)
				const y1 = Math.min(y0 + tileH, h)

				const samples: number[] = []
				for (let y = y0; y < y1; y++) {
					for (let x = x0; x < x1; x++) {
						samples.push(grey[y * w + x] ?? 0)
					}
				}
				samples.sort((a, b) => a - b)
				const p90idx = Math.floor(samples.length * 0.9)
				bg[ty * (TILES + 1) + tx] = samples[p90idx] ?? 255
			}
		}

		// Per-pixel: normalise → contrast → clamp
		const CONTRAST = 1.8
		const WHITE_CLAMP = 240

		for (let y = 0; y < h; y++) {
			const ty = y / tileH
			const ty0 = Math.floor(ty)
			const ty1 = Math.min(ty0 + 1, TILES)
			const fy = ty - ty0

			for (let x = 0; x < w; x++) {
				const tx = x / tileW
				const tx0 = Math.floor(tx)
				const tx1 = Math.min(tx0 + 1, TILES)
				const fx = tx - tx0

				const b00 = bg[ty0 * (TILES + 1) + tx0] ?? 255
				const b10 = bg[ty0 * (TILES + 1) + tx1] ?? 255
				const b01 = bg[ty1 * (TILES + 1) + tx0] ?? 255
				const b11 = bg[ty1 * (TILES + 1) + tx1] ?? 255
				const bgVal =
					b00 * (1 - fx) * (1 - fy) +
					b10 * fx * (1 - fy) +
					b01 * (1 - fx) * fy +
					b11 * fx * fy

				const idx = (y * w + x) * 4
				for (let c = 0; c < 3; c++) {
					const raw = data[idx + c] ?? 0
					let norm = (raw / Math.max(bgVal, 1)) * 255
					norm = (norm - 128) * CONTRAST + 128
					if (norm > WHITE_CLAMP) norm = 255
					data[idx + c] = Math.max(0, Math.min(255, Math.round(norm)))
				}
			}
		}

		ctx.putImageData(imageData, 0, 0)
		return out
	}

	// ── PDF generation ─────────────────────────────────────────────────

	private loadJsPDF(): Promise<void> {
		return new Promise((resolve, reject) => {
			// biome-ignore lint/suspicious/noExplicitAny: jsPDF loaded from CDN
			if ((window as any).jspdf) {
				resolve()
				return
			}
			const script = document.createElement("script")
			script.src =
				"https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"
			script.onload = () => resolve()
			script.onerror = () => reject(new Error("Failed to load jsPDF"))
			document.head.appendChild(script)
		})
	}

	@action async generatePDF() {
		if (this.capturedImages.length === 0) return
		this.isGenerating = true
		try {
			await this.loadJsPDF()
			// biome-ignore lint/suspicious/noExplicitAny: jsPDF loaded from CDN
			const { jsPDF } = (window as any).jspdf
			const pdf = new jsPDF({
				orientation: "portrait",
				unit: "mm",
				format: "a4",
			})
			const pageWidth = pdf.internal.pageSize.getWidth()
			const pageHeight = pdf.internal.pageSize.getHeight()

			for (let i = 0; i < this.capturedImages.length; i++) {
				if (i > 0) pdf.addPage()
				pdf.addImage(this.capturedImages[i], "JPEG", 0, 0, pageWidth, pageHeight)
			}

			const blob = pdf.output("blob")
			const file = new File([blob], `scan-${Date.now()}.pdf`, {
				type: "application/pdf",
			})
			this.args.onScan(file)
		} catch (e) {
			console.error("Failed to generate PDF:", e)
		} finally {
			this.isGenerating = false
		}
	}

	@action handleClose() {
		this.stopCamera()
		this.args.onClose()
	}

	willDestroy() {
		super.willDestroy()
		this.stopCamera()
	}
}