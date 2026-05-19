import { useEffect, useState } from "react";
import { Box, Text, Link, VStack } from "@chakra-ui/react";
import { invoke } from "@tauri-apps/api/tauri";

export const AboutSettings = () => {
  const [version, setVersion] = useState<string>("");

  useEffect(() => {
    invoke("get_app_version").then((v) => setVersion(v as string));
  }, []);

  return (
    <VStack spacing={6} align="stretch">
      <Box>
        <Text fontSize="xl" fontWeight="bold" mb={2}>
          Hermeneia v{version}
        </Text>
        <Text fontSize="sm" color="gray.500" mb={4}>
          Un fork di{" "}
          <Link
            href="https://github.com/pixelsmasher13/platypus"
            isExternal
            color="teal.500"
          >
            Platypus
          </Link>
        </Text>
      </Box>

      <Box>
        <Text fontSize="sm" lineHeight="1.6">
          Copyright (c) 2026 Altea S.p.A. - Tutti i diritti riservati.
          <br />
          Licenza riservata. È vietata la riproduzione, la distribuzione e
          l'ingegneria inversa, totale o parziale, senza previa autorizzazione
          scritta di Altea S.p.A.
        </Text>
      </Box>

      <Box>
        <Text fontSize="sm" lineHeight="1.6">
          Basato su Platypus{" "}
          <Link
            href="https://github.com/pixelsmasher13/platypus"
            isExternal
            color="teal.500"
          >
            (https://github.com/pixelsmasher13/platypus)
          </Link>
          <br />
          La porzione originale del codice è Copyright 2026 pixelsmasher13 e
          rilasciata sotto licenza MIT.
        </Text>
      </Box>

      <Box>
        <Text fontSize="sm" fontWeight="medium" mb={1}>
          Riconoscimenti
        </Text>
        <Text fontSize="sm" lineHeight="1.6">
          Questo software include componenti di terze parti soggette alle
          rispettive licenze, tra cui: whisper.cpp, whisper-rs, Distil-Whisper,
          nnnoiseless, rubato, hnswlib-rs.
        </Text>
      </Box>
    </VStack>
  );
};
