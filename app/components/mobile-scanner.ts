import { action } from "@ember/object"
import Component from "@glimmer/component"
import { tracked } from "@glimmer/tracking"

interface MobileScannerArgs {
	onScan: (file: File) => void
	onClose: () => void
}

export default class MobileScannerComponent extends Component<MobileScannerArgs> {
	// ── UI state ───────────────────────────────────────────────────────
	@tracked isCameraOpen = false
	@tracked cropImageUrl: string | null = null
	@tracked capturedImages: string[] = []
	@tracked isGenerating = false
	@tracked cameraError: string | null = null

	static MAX_PAGES = 20
	private static A4_W = 794
	private static A4_H = 1123

	// ── Internal refs ──────────────────────────────────────────────────
	private stream: MediaStream | null = null
	private videoElement: HTMLVideoElement | null = null
	private liveCanvas: HTMLCanvasElement | null = null
	private liveInterval: ReturnType<typeof setInterval> | null = null

	// Raw Cropper.js instance — loaded from CDN, no addon required
	// Avoids all @embroider/virtual / strict-mode import issues entirely.
	private cropperInstance: any = null

	// ── Derived ────────────────────────────────────────────────────────
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

	// ── Load Cropper.js from CDN ───────────────────────────────────────
	// We load both the JS and CSS. The CSS is injected once into <head>.
	// This avoids ember-cropperjs and all its Embroider compatibility issues.

	private cropperJsLoaded = false

	private async loadCropperJs(): Promise<void> {
		if (this.cropperJsLoaded || (window as any).Cropper) {
			this.cropperJsLoaded = true
			return
		}

		// Inject Cropper.js CSS if not already present
		if (!document.querySelector('link[data-cropper-css]')) {
			const link = document.createElement("link")
			link.rel = "stylesheet"
			link.href = "https://cdnjs.cloudflare.com/ajax/libs/cropperjs/1.6.2/cropper.min.css"
			link.setAttribute("data-cropper-css", "")
			document.head.appendChild(link)
		}

		// Load Cropper.js script
		await new Promise<void>((resolve, reject) => {
			const script = document.createElement("script")
			script.src = "https://cdnjs.cloudflare.com/ajax/libs/cropperjs/1.6.2/cropper.min.js"
			script.onload = () => resolve()
			script.onerror = () => reject(new Error("Failed to load Cropper.js"))
			document.head.appendChild(script)
		})

		this.cropperJsLoaded = true
	}

	// ── Camera ─────────────────────────────────────────────────────────

	@action async openCamera() {
		if (this.isAtPageLimit) return
		this.cameraError = null

		// Pre-load Cropper.js in the background while camera opens
		this.loadCropperJs().catch(() => {})

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
					? "Camera access denied. Please allow camera access in your browser settings."
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
			() => { videoEl.play().catch(() => {}) },
			{ once: true },
		)
	}

	@action setupLiveCanvas(canvas: HTMLCanvasElement) {
		this.liveCanvas = canvas
		const ctx = canvas.getContext("2d", { willReadFrequently: true })
		if (!ctx) return

		const startLoop = () => {
			const video = this.videoElement
			if (!video) return
			this.liveInterval = setInterval(() => {
				if (!video.videoWidth || !video.videoHeight) return
				if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth
				if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight
				try { ctx.drawImage(video, 0, 0, canvas.width, canvas.height) } catch { /* skip */ }
			}, 100)
		}

		const waitForVideo = () => {
			const video = this.videoElement
			if (video && video.readyState >= 2) startLoop()
			else if (video) video.addEventListener("playing", startLoop, { once: true })
			else setTimeout(waitForVideo, 50)
		}
		waitForVideo()
	}

	// ── Capture → Crop ─────────────────────────────────────────────────

	@action capturePhoto() {
		const canvas = this.liveCanvas
		if (!canvas) return

		this.stopLiveLoop()

		try {
			this.cropImageUrl = canvas.toDataURL("image/jpeg", 0.92)
			this.isCameraOpen = false
			// Keep stream alive for fast retake
		} catch {
			this.cameraError = "Could not capture image. Please try again."
		}
	}

	// did-insert on the <img> in crop view — mounts Cropper.js onto it
	@action async setupCropper(imgEl: HTMLImageElement) {
		await this.loadCropperJs()

		const Cropper = (window as any).Cropper
		if (!Cropper) return

		// Destroy any previous instance
		this.cropperInstance?.destroy()

		this.cropperInstance = new Cropper(imgEl, {
			viewMode: 1,          // crop box stays within the canvas
			dragMode: "move",     // drag moves the image, not draws a new box
			aspectRatio: NaN,     // free aspect ratio — user decides
			autoCropArea: 0.95,   // start with crop box covering 95% of image
			responsive: true,
			restore: false,
			guides: true,
			center: true,
			highlight: false,
			cropBoxMovable: true,
			cropBoxResizable: true,
			toggleDragModeOnDblclick: false,
			// iOS Safari: Cropper.js reads image pixels via canvas — must be same-origin.
			// Since we captured from our own canvas this is always fine.
			checkCrossOrigin: false,
		})
	}

	// will-destroy on the <img> — cleans up Cropper.js when crop view unmounts
	@action teardownCropper() {
		this.cropperInstance?.destroy()
		this.cropperInstance = null
	}

	@action confirmCrop() {
		const cropper = this.cropperInstance
		if (!cropper) return

		try {
			const croppedCanvas: HTMLCanvasElement = cropper.getCroppedCanvas({
				width: MobileScannerComponent.A4_W,
				height: MobileScannerComponent.A4_H,
				imageSmoothingEnabled: true,
				imageSmoothingQuality: "high",
			})

			const enhanced = this.enhanceImage(croppedCanvas)
			this.capturedImages = [
				...this.capturedImages,
				enhanced.toDataURL("image/jpeg", 0.85),
			]
		} catch (e) {
			console.error("Crop failed:", e)
		} finally {
			this.cleanupCropState()
			this.stopCamera()
		}
	}

	@action retakePhoto() {
		this.cleanupCropState()
		if (this.stream) {
			// Stream still alive — just flip back to camera view
			this.isCameraOpen = true
		} else {
			this.openCamera()
		}
	}

	private cleanupCropState() {
		this.cropperInstance?.destroy()
		this.cropperInstance = null
		this.cropImageUrl = null
	}

	// ── File input ─────────────────────────────────────────────────────

	@action loadFromFile() {
		const input = document.getElementById("scanner-file-input") as HTMLInputElement
		input?.click()
	}

	@action processFileInput(e: Event) {
		const file = (e.target as HTMLInputElement).files?.[0]
		if (!file) return

		const reader = new FileReader()
		reader.onload = (ev) => {
			const dataUrl = ev.target?.result as string
			if (dataUrl) this.cropImageUrl = dataUrl
		}
		reader.readAsDataURL(file)

		const input = document.getElementById("scanner-file-input") as HTMLInputElement
		if (input) input.value = ""
	}

	// ── Camera teardown ────────────────────────────────────────────────

	private stopLiveLoop() {
		if (this.liveInterval !== null) {
			clearInterval(this.liveInterval)
			this.liveInterval = null
		}
	}

	@action stopCamera() {
		this.stopLiveLoop()
		this.liveCanvas = null
		this.videoElement = null
		if (this.stream) {
			this.stream.getTracks().forEach((t) => t.stop())
			this.stream = null
		}
		this.isCameraOpen = false
	}

	@action removePage(index: number) {
		this.capturedImages = this.capturedImages.filter((_, i) => i !== index)
	}

	// ── Image enhancement ──────────────────────────────────────────────

	private enhanceImage(canvas: HTMLCanvasElement): HTMLCanvasElement {
		const out = document.createElement("canvas")
		out.width = canvas.width
		out.height = canvas.height
		const ctx = out.getContext("2d", { willReadFrequently: true })
		if (!ctx) return canvas

		try { ctx.drawImage(canvas, 0, 0) } catch { return canvas }

		let imageData: ImageData
		try { imageData = ctx.getImageData(0, 0, out.width, out.height) }
		catch { return canvas }

		const data = imageData.data
		const w = out.width
		const h = out.height

		const grey = new Float32Array(w * h)
		for (let i = 0; i < w * h; i++) {
			grey[i] = 0.299 * (data[i * 4] ?? 0)
				+ 0.587 * (data[i * 4 + 1] ?? 0)
				+ 0.114 * (data[i * 4 + 2] ?? 0)
		}

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
				bg[ty * (TILES + 1) + tx] = samples[Math.floor(samples.length * 0.9)] ?? 255
			}
		}

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
			const pw = pdf.internal.pageSize.getWidth()
			const ph = pdf.internal.pageSize.getHeight()
			for (let i = 0; i < this.capturedImages.length; i++) {
				if (i > 0) pdf.addPage()
				pdf.addImage(this.capturedImages[i], "JPEG", 0, 0, pw, ph)
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

	// ── Lifecycle ──────────────────────────────────────────────────────

	@action handleClose() {
		this.stopCamera()
		this.cleanupCropState()
		this.args.onClose()
	}

	willDestroy() {
		super.willDestroy()
		this.stopCamera()
		this.cleanupCropState()
	}
}