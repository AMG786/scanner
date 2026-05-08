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

	private get isIOS(): boolean {
		return (
			/iPad|iPhone|iPod/.test(navigator.userAgent) ||
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
			const timeout = setTimeout(() => reject(new Error("OpenCV timed out")), 15000)
			const check = () => {
				const cv = (window as any).cv
				if (cv && cv.Mat) {
					clearTimeout(timeout)
					resolve()
				} else if (cv && cv.onRuntimeInitialized !== undefined) {
					cv.onRuntimeInitialized = () => { clearTimeout(timeout); resolve() }
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
			this.scanner = new (window as any).jscanify()
			this.libsReady = true
		} catch (e) {
			console.warn("Scanner libs failed to load, will use raw capture:", e)
		} finally {
			this.libsLoading = false
		}
	}

	// ── Camera ─────────────────────────────────────────────────────────

	@action async openCamera() {
		if (this.isAtPageLimit) return
		this.cameraError = null

		this.loadScannerLibs().catch(() => {})

		try {
			const constraints: MediaStreamConstraints = {
				video: {
					facingMode: { ideal: "environment" },
					...(this.isIOS ? {} : { width: { ideal: 1920 }, height: { ideal: 1080 } }),
				},
			}
			this.stream = await navigator.mediaDevices.getUserMedia(constraints)
			this.isCameraOpen = true
		} catch (err: any) {
			this.cameraError =
				err?.name === "NotAllowedError"
					? "Camera access denied. Please allow camera access in your browser settings and try again."
					: err?.name === "NotFoundError"
						? "No camera found on this device."
						: `Could not start camera: ${err?.message ?? "unknown error"}`
		}
	}

	@action setupVideoElement(videoEl: HTMLVideoElement) {
		this.videoElement = videoEl
		if (!this.stream) return

		videoEl.setAttribute("autoplay", "")
		videoEl.setAttribute("muted", "")
		videoEl.setAttribute("playsinline", "")
		videoEl.muted = true
		videoEl.playsInline = true
		videoEl.srcObject = this.stream

		videoEl.addEventListener(
			"loadedmetadata",
			() => { videoEl.play().catch((e) => console.warn("video.play() failed:", e)) },
			{ once: true },
		)
	}

	@action setupHighlightCanvas(canvas: HTMLCanvasElement) {
		this.highlightCanvas = canvas

		const ctx = canvas.getContext("2d", { willReadFrequently: true })
		if (!ctx) return

		const startLoop = () => {
			const video = this.videoElement
			if (!video) return

			// Small off-screen canvas used ONLY for jscanify detection.
			// Running detection on 320px wide instead of full screen is ~10x faster
			// because jscanify/OpenCV work on pixel count — fewer pixels = faster Canny.
			const DETECT_W = 320
			const detectCanvas = document.createElement("canvas")
			detectCanvas.width = DETECT_W
			const detectCtx = detectCanvas.getContext("2d", { willReadFrequently: true })!

			// Use requestAnimationFrame for the video draw (smooth, synced to display)
			// and a separate slower interval just for the jscanify detection pass.
			let lastHighlight: HTMLCanvasElement | null = null
			let detectionRunning = false

			const drawFrame = () => {
				if (!this.highlightInterval) return // stopped
				if (!video.videoWidth || !video.videoHeight) {
					requestAnimationFrame(drawFrame)
					return
				}

				// Fit canvas to screen width, preserve aspect ratio
				const displayW = canvas.clientWidth || window.innerWidth
				const aspect = video.videoWidth / video.videoHeight
				const drawW = displayW
				const drawH = Math.round(displayW / aspect)

				if (canvas.width !== drawW) canvas.width = drawW
				if (canvas.height !== drawH) canvas.height = drawH

				try {
					// 1. Draw live video frame
					ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
					// 2. Overlay the last computed highlight on top (if any)
					if (lastHighlight) {
						ctx.drawImage(lastHighlight, 0, 0, canvas.width, canvas.height)
					}
				} catch { /* video not ready */ }

				requestAnimationFrame(drawFrame)
			}

			// Detection runs on a slower tick — 80ms (~12fps) is plenty for border tracking
			// and cheap because we run jscanify on the tiny 320px canvas, not the full one.
			const runDetection = () => {
				if (!this.scanner || detectionRunning) return
				if (!video.videoWidth || !video.videoHeight) return

				detectionRunning = true
				try {
					// Scale detect canvas to match video aspect
					const aspect = video.videoWidth / video.videoHeight
					detectCanvas.height = Math.round(DETECT_W / aspect)

					// Draw tiny version of the current video frame
					detectCtx.drawImage(video, 0, 0, DETECT_W, detectCanvas.height)

					// Run jscanify on the tiny canvas — fast
					const highlighted = this.scanner.highlightPaper(detectCanvas)

					// Store for the rAF loop to overlay (it scales it back up via drawImage)
					lastHighlight = highlighted
				} catch {
					// No document in frame — clear the highlight so stale outline disappears
					lastHighlight = null
				} finally {
					detectionRunning = false
				}
			}

			// Kick off both loops
			requestAnimationFrame(drawFrame)
			// Store interval ID so stopCamera() can clear it
			this.highlightInterval = setInterval(runDetection, 80) as any
		}

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
				scanned = document.createElement("canvas")
				scanned.width = canvas.width
				scanned.height = canvas.height
				scanned.getContext("2d", { willReadFrequently: true })?.drawImage(canvas, 0, 0)
			}

			const enhanced = this.enhanceImage(scanned)
			this.capturedImages = [
				...this.capturedImages,
				enhanced.toDataURL("image/jpeg", 0.85),
			]
		} catch (_e) {
			console.error("Capture error:", _e)
			try {
				this.capturedImages = [
					...this.capturedImages,
					canvas.toDataURL("image/jpeg", 0.7),
				]
			} catch {
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
				fallback.getContext("2d", { willReadFrequently: true })!.drawImage(img, 0, 0)
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
			const input = document.getElementById("scanner-file-input") as HTMLInputElement
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
	//
	// Goal: make scanned documents look like a professional flatbed scan —
	// paper is clean white, text is dark and crisp, NO yellow cast.
	//
	// The previous version (CONTRAST=1.8, WHITE_CLAMP=240) was too aggressive.
	// It normalised so hard that warm paper tones were pushed into yellow
	// and light grey text became invisible.
	//
	// New approach — two gentle passes:
	//
	// Pass 1 — Adaptive background normalisation (tiles):
	//   Estimate the paper brightness locally so that uneven lighting
	//   (shadows on one side, bright window on the other) is corrected.
	//   We use the 85th-percentile luminance per tile (was 90th) — slightly
	//   less aggressive so we don't over-whiten coloured paper.
	//
	// Pass 2 — Desaturate near-white pixels only:
	//   After normalisation, paper that should be white sometimes has a
	//   warm/yellow tint from the camera's white balance. We identify pixels
	//   that are "nearly white" (luminance > 200 after normalisation) and
	//   gently pull their saturation toward zero. This removes the yellow cast
	//   from the paper while leaving text and coloured content completely alone.

	private enhanceImage(canvas: HTMLCanvasElement): HTMLCanvasElement {
		const out = document.createElement("canvas")
		out.width = canvas.width
		out.height = canvas.height

		const ctx = out.getContext("2d", { willReadFrequently: true })
		if (!ctx) return canvas

		try { ctx.drawImage(canvas, 0, 0) } catch { return canvas }

		let imageData: ImageData
		try {
			imageData = ctx.getImageData(0, 0, out.width, out.height)
		} catch {
			return canvas
		}

		const data = imageData.data
		const w = out.width
		const h = out.height

		// ── Build greyscale luminance map ──────────────────────────────
		const grey = new Float32Array(w * h)
		for (let i = 0; i < w * h; i++) {
			grey[i] =
				0.299 * (data[i * 4] ?? 0) +
				0.587 * (data[i * 4 + 1] ?? 0) +
				0.114 * (data[i * 4 + 2] ?? 0)
		}

		// ── Tile-based background estimation ──────────────────────────
		// 85th percentile (not 90th) — less aggressive, avoids over-whitening
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
				for (let y = y0; y < y1; y++)
					for (let x = x0; x < x1; x++)
						samples.push(grey[y * w + x] ?? 0)
				samples.sort((a, b) => a - b)
				// 85th percentile — gentler than before
				bg[ty * (TILES + 1) + tx] = samples[Math.floor(samples.length * 0.85)] ?? 255
			}
		}

		// ── Per-pixel: normalise + gentle contrast + desaturate near-whites ──
		//
		// CONTRAST = 1.3  (was 1.8 — much gentler, preserves natural tones)
		// WHITE_CLAMP = 245 (was 240 — only force truly near-white pixels to white)
		// DESAT_THRESHOLD = 210 — pixels brighter than this get desaturated toward grey
		// DESAT_STRENGTH = 0.75 — how strongly to pull toward grey (0=none, 1=full grey)

		const CONTRAST = 1.3
		const WHITE_CLAMP = 245
		const DESAT_THRESHOLD = 210
		const DESAT_STRENGTH = 0.75

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
				let r = data[idx] ?? 0
				let g = data[idx + 1] ?? 0
				let b = data[idx + 2] ?? 0

				// Normalise each channel against local background
				const scale = 255 / Math.max(bgVal, 1)
				r = r * scale
				g = g * scale
				b = b * scale

				// Gentle contrast stretch
				r = (r - 128) * CONTRAST + 128
				g = (g - 128) * CONTRAST + 128
				b = (b - 128) * CONTRAST + 128

				// Clamp to 0-255
				r = Math.max(0, Math.min(255, r))
				g = Math.max(0, Math.min(255, g))
				b = Math.max(0, Math.min(255, b))

				// Force near-white pixels to pure white
				if (r > WHITE_CLAMP && g > WHITE_CLAMP && b > WHITE_CLAMP) {
					r = 255; g = 255; b = 255
				} else {
					// Desaturate near-white pixels to remove yellow camera cast.
					// Only applies to bright pixels — dark text is untouched.
					const lum = 0.299 * r + 0.587 * g + 0.114 * b
					if (lum > DESAT_THRESHOLD) {
						r = r + (lum - r) * DESAT_STRENGTH
						g = g + (lum - g) * DESAT_STRENGTH
						b = b + (lum - b) * DESAT_STRENGTH
					}
				}

				data[idx]     = Math.round(r)
				data[idx + 1] = Math.round(g)
				data[idx + 2] = Math.round(b)
			}
		}

		ctx.putImageData(imageData, 0, 0)
		return out
	}

	// ── PDF generation ─────────────────────────────────────────────────

	private loadJsPDF(): Promise<void> {
		return new Promise((resolve, reject) => {
			if ((window as any).jspdf) { resolve(); return }
			const script = document.createElement("script")
			script.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"
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
			const { jsPDF } = (window as any).jspdf
			const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" })
			const pageWidth = pdf.internal.pageSize.getWidth()
			const pageHeight = pdf.internal.pageSize.getHeight()

			for (let i = 0; i < this.capturedImages.length; i++) {
				if (i > 0) pdf.addPage()
				pdf.addImage(this.capturedImages[i], "JPEG", 0, 0, pageWidth, pageHeight)
			}

			const blob = pdf.output("blob")
			const file = new File([blob], `scan-${Date.now()}.pdf`, { type: "application/pdf" })
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