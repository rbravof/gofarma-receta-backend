// api/procesar-receta.js
import formidable from "formidable";
import fs from "fs";
import { ImageAnnotatorClient } from "@google-cloud/vision";
import axios from "axios";

export const config = {
  api: {
    bodyParser: false,
  },
};

const client = new ImageAnnotatorClient({
  keyFilename: "credenciales-google.json",
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Método no permitido");
  }

  const form = new formidable.IncomingForm({ uploadDir: "/tmp", keepExtensions: true });

  form.parse(req, async (err, fields, files) => {
    if (err) return res.status(500).json({ error: "Error subiendo archivo" });

    try {
      const path = files.receta.filepath;

      const [result] = await client.textDetection(path);
      const texto = result.textAnnotations?.[0]?.description || "";

      const medicamentos = extraerMedicamentos(texto);
      const productos = await buscarProductosEnShopify(medicamentos);
      const carrito = await crearCarrito(productos);

      res.status(200).json({ link: carrito.checkoutUrl });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Error procesando receta" });
    }
  });
}

// funciones auxiliares como antes:

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

    const response = await axios.post(
      process.env.SHOPIFY_API_URL,
      { query },
      {
        headers: {
          "X-Shopify-Storefront-Access-Token": process.env.SHOPIFY_STOREFRONT_TOKEN,
          "Content-Type": "application/json",
        },
      }
    );

    const variante = response.data?.data?.products?.edges?.[0]?.node?.variants?.edges?.[0]?.node?.id;

    if (variante) {
      productos.push({ merchandiseId: variante, quantity: 1 });
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
      variables: { input: { lines: productos } },
    },
    {
      headers: {
        "X-Shopify-Storefront-Access-Token": process.env.SHOPIFY_STOREFRONT_TOKEN,
        "Content-Type": "application/json",
      },
    }
  );

  return response.data.data.cartCreate.cart;
}
