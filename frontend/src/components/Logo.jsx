// Creative Mojo brand mark. Single source of truth for the logo so
// future swaps (size, file, dark/light variants) happen in one place.
//   <Logo />                  → dark logo, suitable for light backgrounds
//   <Logo variant="white" />  → reversed (white) logo for dark backgrounds
export default function Logo({ className = "h-9", alt = "Creative Mojo", variant = "dark" }) {
  const src = variant === "white"
    ? "/brand/creative-mojo-logo-white.png"
    : "/brand/creative-mojo-logo.png";
  return (
    <img
      src={src}
      alt={alt}
      className={`${className} w-auto object-contain select-none`}
      draggable={false}
    />
  );
}
