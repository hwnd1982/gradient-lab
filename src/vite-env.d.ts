/// <reference types="vite/client" />

interface ImportMetaEnv {
    /** токен прод-мутаций Agent API; должен совпадать с LAB_API_TOKEN на сервере (собирается в бандл — только для закрытых инстансов) */
    readonly VITE_LAB_TOKEN?: string;
}
