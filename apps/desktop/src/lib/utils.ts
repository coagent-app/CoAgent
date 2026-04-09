import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Reads a browser `File` as a base64 string (without the `data:<mime>;base64,`
 * prefix). Used by both the global drop handler in useAgent and FilesPane's
 * readAndSend to funnel files through the WS `ingest_file` message.
 * Rejects if the FileReader errors or the result is empty.
 */
export function readFileAsBase64(file: globalThis.File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      const base64 = result.split(',')[1] ?? ''
      if (!base64) {
        reject(new Error(`"${file.name}" appears to be empty`))
        return
      }
      resolve(base64)
    }
    reader.onerror = () => {
      reject(new Error(`Could not read "${file.name}"`))
    }
    reader.readAsDataURL(file)
  })
}
