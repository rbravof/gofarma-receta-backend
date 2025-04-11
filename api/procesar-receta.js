import formidable from "formidable";
import fs from "fs";
import { ImageAnnotatorClient } from "@google-cloud/vision";
import axios from "axios";

export const config = {
  api: {
    bodyParser: false,
  },
};

// 📂 Reconstruir archivo de credenciales desde variable base64
const credentialsPath = "/tmp/credenciales-google.json";

if (process.env.GOOGLE_CREDENTIALS_BASE64) {
  try {
    const jsonContent = Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, "base64").toString("utf-8");
    fs.writeFileSync(credentialsPath, jsonContent);
    console.log("✅ Archivo de credenciales creado en /tmp");
  } catch (err) {
    console.error("❌ Error al reconstruir credenciales:", err);
  }
}

const client = new ImageAnnotatorClient({
  keyFilename: credentialsPath,
});

export default async function handler(req, res) {
  // 🔐 Habilitar CORS para Shopify
  res.setHeader("Access-Control-Allow-Origin", "https://gofarma.cl");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end(); // Preflight CORS OK
  }

  if (req.method !== "POST") {
    return res.status(405).send("Método no permitido");
  }

  const form = new formidable.IncomingForm({ uploadDir: "/tmp", keepExtensions: true });

  form.parse(req, async (err, fields, files) => {
    if (err || !files.receta) {
      return res.status(400).json({ error: "Archivo no recibido correctamente" });
    }

    try {
      const filePath = files.receta.filepath;

      // 👁️ Detectar texto desde imagen
      const [result] = await client.textDetection(filePath);
      const texto = result.textAnnotations?.[0]?.description || "";

      console.log("📝 Texto extraído:", texto);

      const medicamentos = extraerMedicamentos(texto);
      const productos = await buscarProductosEnShopify(medicamentos);
      const carrito = await crearCarrito(productos);

      return res.status(200).json({ link: carrito.checkoutUrl });
    } catch (error) {
      console.error("❌ Error procesando receta:", error);
      return res.status(500).json({ error: "Error procesando receta" });
    }
  });
}

// 🔎 Extraer nombres simples de medicamentos desde OCR
function extraerMedicamentos(texto) {
  return texto
    .toLowerCase()
    .split(/\n|,|;/)
    .map((linea) => linea.trim())
    .filter((l) => l.length > 3)
    .slice(0, 5);
}

// 🔍 Buscar productos en Shopify
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
      console.warn(`⚠️ No se pudo encontrar "${nombre}" en Shopify`);
    }
  }

  return productos;
}

// 🛒 Crear carrito prellenado
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
