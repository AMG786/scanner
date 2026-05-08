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
		return new Promise((resolve) => {
			const check = () => {
				// biome-ignore lint/suspicious/noExplicitAny: opencv global
				const cv = (window as any).cv
				if (cv && cv.Mat) {
					resolve()
				} else if (cv) {
					cv.onRuntimeInitialized = resolve
				} else {
					setTimeout(check, 100)
				}
			}
			check()
		})
	}

	private async loadScannerLibs(): Promise<void> {
		if (this.libsReady) return
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
		} finally {
			this.libsLoading = false
		}
	}

	@action async openCamera() {
		if (this.isAtPageLimit) return
		this.cameraError = null

		// Load scanner libs in background while camera opens
		this.loadScannerLibs()

		try {
			this.stream = await navigator.mediaDevices.getUserMedia({
				video: { facingMode: { ideal: "environment" } },
			})
			this.isCameraOpen = true
		} catch (_e) {
			this.cameraError =
				"Camera access denied. Please allow camera access in your browser settings and try again."
		}
	}

	@action setupVideoElement(videoEl: HTMLVideoElement) {
		if (this.stream) {
			videoEl.srcObject = this.stream
		}
	}

	// Called by did-insert on the highlight canvas element.
	// Starts a 10fps loop: draw video frame → run jscanify highlightPaper → display result.
	@action setupHighlightCanvas(canvas: HTMLCanvasElement) {
		this.highlightCanvas = canvas
		const video = document.getElementById("scanner-video") as HTMLVideoElement
		if (!video) return

		const startLoop = () => {
			const ctx = canvas.getContext("2d")
			if (!ctx) return

			this.highlightInterval = setInterval(() => {
				if (!video.videoWidth || !video.videoHeight) return
				if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth
				if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight

				ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

				if (this.scanner) {
					try {
						const highlighted = this.scanner.highlightPaper(canvas)
						ctx.clearRect(0, 0, canvas.width, canvas.height)
						ctx.drawImage(highlighted, 0, 0)
					} catch {
						// Scanner not ready yet or no document detected — show raw frame
					}
				}
			}, 100)
		}

		if (video.readyState >= 2) {
			startLoop()
		} else {
			video.addEventListener("playing", startLoop, { once: true })
		}
	}

	@action async capturePhoto() {
		if (this.isAtPageLimit) return

		const canvas = this.highlightCanvas
		if (!canvas) return

		// Stop the highlight loop before we mutate state
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
				scanned = canvas
			}
			const enhanced = this.enhanceImage(scanned)
			this.capturedImages = [
				...this.capturedImages,
				enhanced.toDataURL("image/jpeg", 0.85),
			]
		} catch (_e) {
			// Fallback to raw frame on any scan error
			this.capturedImages = [
				...this.capturedImages,
				canvas.toDataURL("image/jpeg", 0.7),
			]
		} finally {
			this.isProcessingImage = false
			this.stopCamera()
		}
	}

	// ── File input (for testing on desktop) ────────────────────────────

	@action loadFromFile() {
		const input = document.getElementById(
			"scanner-file-input",
		) as HTMLInputElement
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
			await new Promise<void>((resolve) => {
				img.onload = () => resolve()
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
				fallback.width = img.width
				fallback.height = img.height
				// biome-ignore lint/style/noNonNullAssertion: canvas always has 2d context
				fallback.getContext("2d")!.drawImage(img, 0, 0)
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

	@action stopCamera() {
		if (this.highlightInterval !== null) {
			clearInterval(this.highlightInterval)
			this.highlightInterval = null
		}
		this.highlightCanvas = null
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
	 * Produces a clean, professional "scanned document" look:
	 *
	 * 1. Adaptive threshold — estimates the local background brightness across
	 *    a grid of tiles and normalises each tile independently. This is what
	 *    makes uneven lighting (stairwell shadows, harsh sunlight on one corner)
	 *    disappear and turns the paper a uniform white.
	 *
	 * 2. Contrast stretch — after normalisation the histogram is compressed;
	 *    a gentle contrast boost re-separates ink from paper.
	 *
	 * 3. White-point clamp — pixels above a high threshold are forced to pure
	 *    white, eliminating residual grey cast on the paper.
	 */
	private enhanceImage(canvas: HTMLCanvasElement): HTMLCanvasElement {
		const out = document.createElement("canvas")
		out.width = canvas.width
		out.height = canvas.height
		const ctx = out.getContext("2d")
		if (!ctx) return canvas

		ctx.drawImage(canvas, 0, 0)
		const imageData = ctx.getImageData(0, 0, out.width, out.height)
		const data = imageData.data
		const w = out.width
		const h = out.height

		// ── Step 1: convert to greyscale luminance map ──────────────────
		const grey = new Float32Array(w * h)
		for (let i = 0; i < w * h; i++) {
			const r = data[i * 4] ?? 0
			const g = data[i * 4 + 1] ?? 0
			const b = data[i * 4 + 2] ?? 0
			grey[i] = 0.299 * r + 0.587 * g + 0.114 * b
		}

		// ── Step 2: estimate background via a coarse tile grid ──────────
		// Each tile's 90th-percentile luminance ≈ background brightness.
		// We bilinearly interpolate between tile centres to get a smooth
		// background map — this is the core of adaptive thresholding.
		const TILES = 8 // 8×8 grid
		const tileW = Math.ceil(w / TILES)
		const tileH = Math.ceil(h / TILES)
		const bg = new Float32Array((TILES + 1) * (TILES + 1))

		for (let ty = 0; ty <= TILES; ty++) {
			for (let tx = 0; tx <= TILES; tx++) {
				// Clamp tile bounds to image edges
				const x0 = Math.min(tx * tileW, w - 1)
				const y0 = Math.min(ty * tileH, h - 1)
				const x1 = Math.min(x0 + tileW, w)
				const y1 = Math.min(y0 + tileH, h)

				// Collect luminance samples in this tile
				const samples: number[] = []
				for (let y = y0; y < y1; y++) {
					for (let x = x0; x < x1; x++) {
						samples.push(grey[y * w + x] ?? 0)
					}
				}
				samples.sort((a, b) => a - b)
				// 90th percentile ≈ paper brightness in this region
				const p90idx = Math.floor(samples.length * 0.9)
				bg[ty * (TILES + 1) + tx] = samples[p90idx] ?? 255
			}
		}

		// ── Step 3: apply adaptive normalisation + contrast ─────────────
		const CONTRAST = 1.8 // increase ink-to-paper separation
		const WHITE_CLAMP = 240 // pixels brighter than this → pure white

		for (let y = 0; y < h; y++) {
			// Tile-space y coordinate (fractional)
			const ty = (y / tileH)
			const ty0 = Math.floor(ty)
			const ty1 = Math.min(ty0 + 1, TILES)
			const fy = ty - ty0

			for (let x = 0; x < w; x++) {
				const tx = (x / tileW)
				const tx0 = Math.floor(tx)
				const tx1 = Math.min(tx0 + 1, TILES)
				const fx = tx - tx0

				// Bilinear interpolation of background brightness
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
					// Normalise: scale so that bgVal maps to 255 (paper → white)
					let norm = (raw / Math.max(bgVal, 1)) * 255
					// Contrast stretch around midpoint
					norm = (norm - 128) * CONTRAST + 128
					// White-point clamp: near-white → pure white
					if (norm > WHITE_CLAMP) norm = 255
					data[idx + c] = Math.max(0, Math.min(255, Math.round(norm)))
				}
				// alpha unchanged
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
				pdf.addImage(
					this.capturedImages[i],
					"JPEG",
					0,
					0,
					pageWidth,
					pageHeight,
				)
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