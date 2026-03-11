/** @type {import('tailwindcss').Config} */
export default {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            colors: {
                whatsapp: {
                    light: '#25D366',
                    dark: '#128C7E',
                    bg: '#111b21',
                    panel: '#202c33',
                    border: '#2a3942'
                }
            }
        },
    },
    plugins: [],
}
