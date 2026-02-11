import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
    return (
        <div className="min-h-screen flex items-center justify-center">
            <SignIn
                appearance={{
                    elements: {
                        formButtonPrimary: "bg-[#1E3A5F] hover:bg-[#162d4a]",
                        card: "shadow-lg",
                    },
                }}
            />
        </div>
    );
}
