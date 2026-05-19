import React, { useState } from "react";
import {
  Modal,
  ModalOverlay,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalCloseButton,
  Box,
  Tabs,
  TabList,
  TabPanels,
  Tab,
  TabPanel,
} from "@chakra-ui/react";
import { Title } from "@hermeneia-app/design";
import { GeneralSettings, EndpointsSettings, ModelsSettings, AboutSettings } from "../../../features";

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  activeCategory?: string;
  setActiveCategory?: (category: string) => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState(0);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      isCentered
      motionPreset="slideInBottom"
      scrollBehavior="inside"
    >
      <ModalOverlay />
      <ModalContent
        width="100%"
        maxWidth="600px"
        height="auto"
        maxHeight="80vh"
        css={`
          @media (max-width: 1024px) {
            max-width: 90%;
          }
        `}
      >
        <ModalHeader>
          <Title type="m">Settings</Title>
        </ModalHeader>
        <ModalCloseButton />
        <ModalBody
          pb={6}
          sx={{
            "&::-webkit-scrollbar": { width: "8px" },
            "&::-webkit-scrollbar-track": { bg: "gray.50", borderRadius: "4px" },
            "&::-webkit-scrollbar-thumb": { bg: "gray.300", borderRadius: "4px" },
            "&::-webkit-scrollbar-thumb:hover": { bg: "gray.400" },
          }}
        >
          <Tabs
            index={activeTab}
            onChange={setActiveTab}
            variant="enclosed"
          >
            <TabList>
              <Tab>General</Tab>
              <Tab>Endpoints</Tab>
              <Tab>Models</Tab>
              <Tab>About</Tab>
            </TabList>
            <TabPanels>
              <TabPanel pb={6}>
                <Box>
                  <GeneralSettings />
                </Box>
              </TabPanel>
              <TabPanel pb={6}>
                <Box>
                  <EndpointsSettings />
                </Box>
              </TabPanel>
              <TabPanel pb={6}>
                <Box>
                  <ModelsSettings />
                </Box>
              </TabPanel>
              <TabPanel pb={6}>
                <AboutSettings />
              </TabPanel>
            </TabPanels>
          </Tabs>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
};
