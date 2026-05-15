// Creative Mojo brand mark. Single source of truth for the logo so
// future swaps (size, file, dark/light variants) happen in one place.
export default function Logo({ className = "h-9", alt = "Creative Mojo" }) {
  return (
    <img
      src="/brand/creative-mojo-logo.png"
      alt={alt}
      className={`${className} w-auto object-contain select-none`}
      draggable={false}
    />
  );
}
