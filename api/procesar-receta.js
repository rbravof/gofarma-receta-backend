import formidable from "formidable";
import fs from "fs";
import { ImageAnnotatorClient } from "@google-cloud/vision";
import axios from "axios";

export const config = {
  api: {
    bodyParser: false,
  },
};

const credentialsPath = "/tmp/credenciales-google.json";

try {
  const jsonContent = Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, "base64").toString("utf-8");
  fs.writeFileSync(credentialsPath, jsonContent);
  console.log("✅ Credenciales Google reconstruidas");
} catch (err) {
  console.error("❌ Error cargando credenciales:", err);
}

const client = new ImageAnnotatorClient({
  keyFilename: credentialsPath,
});

export default async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "https://gofarma.cl");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    console.warn(`❌ Método HTTP no permitido: ${req.method}`);
    return res.status(405).json({ error: "Método no permitido" });
  }

  console.log("📩 Solicitud POST recibida");

  const form = new formidable.IncomingForm({ uploadDir: "/tmp", keepExtensions: true });

  form.parse(req, async (err, fields, files) => {
    if (err) {
      console.error("❌ Error al parsear formulario:", err);
      return res.status(400).json({ error: "Error al parsear archivo de receta" });
    }

    if (!files.receta) {
      console.warn("⚠️ No se recibió archivo con campo 'receta'");
      return res.status(400).json({ error: "No se recibió el archivo 'receta'" });
    }

    const filePath = files.receta.filepath;
    const fileSize = files.receta.size;
    const fileType = files.receta.mimetype;

    console.log(`📎 Archivo recibido: ${filePath} (${fileType}) - ${fileSize} bytes`);

    try {
      const [result] = await client.textDetection(filePath);
      const texto = result.textAnnotations?.[0]?.description || "";

      console.log("🧠 Texto detectado por OCR:", texto);

      const medicamentos = extraerMedicamentos(texto);
      console.log("🩺 Medicamentos detectados:", medicamentos);

      const productos = await buscarProductosEnShopify(medicamentos);
      console.log("🛍️ Productos encontrados en Shopify:", productos);

      if (!productos.length) {
        return res.status(200).json({ error: "No se encontraron productos en el catálogo" });
      }

      const carrito = await crearCarrito(productos);
      console.log("🛒 Carrito generado:", carrito.checkoutUrl);

      return res.status(200).json({ link: carrito.checkoutUrl });
    } catch (error) {
      console.error("❌ Error interno en el procesamiento:", error);
      return res.status(500).json({ error: "Error interno procesando receta", detalles: error.message });
    }
  });
}

function extraerMedicamentos(texto) {
  return texto
    .toLowerCase()
    .split(/\n|,|;/)
    .map((l) => l.trim())
    .filter((l) => l.length > 3)
    .slice(0, 5);
}

async function buscarProductosEnShopify(nombres) {
  const productos = [];

  for (const nombre of nombres) {
    const query = `
      {
        products(first: 1, query: "${nombre}") {
          edges {
            node {
              variants(first: 1) {
                edges {
                  node {
                    id
                  }
                }
              }
            }
          }
        }
      }
    `;

    try {
      const response = await axios.post(
        process.env.SHOPIFY_API_URL,
        { query },
        {
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Storefront-Access-Token": process.env.SHOPIFY_STOREFRONT_TOKEN,
          },
        }
      );

      const variante = response?.data?.data?.products?.edges?.[0]?.node?.variants?.edges?.[0]?.node?.id;
      if (variante) {
        productos.push({ merchandiseId: variante, quantity: 1 });
      }
    } catch (err) {
      console.warn(`🔍 No se encontró "${nombre}" en Shopify`);
    }
  }

  return productos;
}

async function crearCarrito(productos) {
  const mutation = `
    mutation cartCreate($input: CartInput!) {
      cartCreate(input: $input) {
        cart {
          id
          checkoutUrl
        }
      }
    }
  `;

  const response = await axios.post(
    process.env.SHOPIFY_API_URL,
    {
      query: mutation,
      variables: {
        input: {
          lines: productos,
        },
      },
    },
    {
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": process.env.SHOPIFY_STOREFRONT_TOKEN,
      },
    }
  );

  return response.data.data.cartCreate.cart;
}
