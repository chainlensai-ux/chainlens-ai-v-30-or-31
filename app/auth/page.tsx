import AuthForm from '@/components/AuthForm';

export default function AuthPage() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-[#0b0b0b] px-4">
      <div className="w-full max-w-sm">
        <AuthForm />
      </div>
    </div>
  );
}
