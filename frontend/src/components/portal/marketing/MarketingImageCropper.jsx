// Free-form image cropper used by the Marketing compose modal. Wraps
// `react-image-crop` — drag any edge/corner to shape the crop, then
// click Crop to feed a JPEG Blob back to the parent. Keeps memory
// tidy by revoking the object URL on unmount.
import { useEffect, useRef, useState } from "react";
import ReactCrop, { centerCrop, makeAspectCrop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import { X, Crop as CropIcon, Loader2 } from "lucide-react";

export default function MarketingImageCropper({ open, file, onCancel, onDone }) {
  const [src, setSrc] = useState("");
  const [crop, setCrop] = useState();
  const [completedCrop, setCompletedCrop] = useState();
  const [busy, setBusy] = useState(false);
  const imgRef = useRef(null);

  useEffect(() => {
    if (!open || !file) { setSrc(""); return; }
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [open, file]);

  const onImageLoad = (e) => {
    const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
    // Default crop: centred, 80% of shortest side, free-form so the user
    // can drag any handle to reshape.
    const initial = centerCrop(
      makeAspectCrop({ unit: "%", width: 80 }, w / h, w, h),
      w, h,
    );
    setCrop(initial);
  };

  const doCrop = async () => {
    if (!completedCrop || !imgRef.current) return;
    setBusy(true);
    try {
      const blob = await renderCropToBlob(imgRef.current, completedCrop);
      onDone(blob);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("crop failed", e);
      onDone(null);
    } finally { setBusy(false); }
  };

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[80] bg-stone-950/60 backdrop-blur-sm flex items-center justify-center p-6" data-testid="marketing-crop-modal">
      <div className="bg-white rounded-2xl shadow-2xl max-w-3xl w-full overflow-hidden flex flex-col max-h-[92vh]">
        <div className="px-5 py-3 border-b border-stone-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CropIcon className="w-4 h-4 text-stone-700" />
            <span className="text-[10px] uppercase tracking-[0.3em] font-bold text-stone-700">Crop your image</span>
          </div>
          <button onClick={onCancel} className="w-9 h-9 flex items-center justify-center hover:bg-stone-100 rounded-lg" data-testid="marketing-crop-cancel">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto bg-stone-50 p-6 flex items-center justify-center">
          {src ? (
            <ReactCrop
              crop={crop}
              onChange={(c) => setCrop(c)}
              onComplete={(c) => setCompletedCrop(c)}
              ruleOfThirds
            >
              <img
                ref={imgRef}
                src={src}
                alt="Selected for cropping"
                onLoad={onImageLoad}
                style={{ maxHeight: "65vh", maxWidth: "100%" }}
                data-testid="marketing-crop-image"
              />
            </ReactCrop>
          ) : (
            <div className="text-stone-400">No image selected</div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-stone-200 bg-stone-50 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-xs font-bold uppercase tracking-wider border border-stone-300 bg-white hover:bg-stone-50 rounded-lg"
          >
            Cancel
          </button>
          <button
            onClick={doCrop}
            disabled={busy || !completedCrop}
            data-testid="marketing-crop-apply"
            className="px-5 py-2 text-xs font-bold uppercase tracking-wider bg-[#dddd16] hover:bg-[#aaaa11] text-stone-950 rounded-lg flex items-center gap-1.5 disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CropIcon className="w-3.5 h-3.5" />}
            Crop &amp; use
          </button>
        </div>
      </div>
    </div>
  );
}

// Render the chosen crop region of `image` to a JPEG Blob using a
// canvas. We use the natural width/height so the output is full
// resolution — react-image-crop reports the crop relative to the
// *displayed* image, so we scale up.
async function renderCropToBlob(image, crop) {
  const scaleX = image.naturalWidth / image.width;
  const scaleY = image.naturalHeight / image.height;
  const pixelW = Math.round(crop.width * scaleX);
  const pixelH = Math.round(crop.height * scaleY);
  const canvas = document.createElement("canvas");
  canvas.width = pixelW;
  canvas.height = pixelH;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(
    image,
    crop.x * scaleX, crop.y * scaleY,
    crop.width * scaleX, crop.height * scaleY,
    0, 0, pixelW, pixelH,
  );
  return await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/jpeg", 0.9),
  );
}
