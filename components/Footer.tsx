export default function Footer() {
  return (
    <footer className="mt-32 py-10 text-center text-white/50 border-t border-white/10">
      <p>© {new Date().getFullYear()} Clark AI — Built for Base</p>
      <p className="mt-2 text-xs text-white/30">
        Support &amp; legal:{' '}
        <a href="mailto:chainlensai@gmail.com" className="text-teal-400/70 hover:text-teal-400 transition-colors">
          chainlensai@gmail.com
        </a>
      </p>
    </footer>
  );
}
