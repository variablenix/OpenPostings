// @ts-check

import { themes as prismThemes } from "prism-react-renderer";

const githubOwner = process.env.GITHUB_OWNER || "Masterjx9";
const githubRepo = process.env.GITHUB_REPO || "OpenPostings";
const isUserSite = githubRepo.toLowerCase() === `${githubOwner.toLowerCase()}.github.io`;
const githubUrl = `https://github.com/${githubOwner}/${githubRepo}`;

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: "OpenPostings",
  tagline: "Open-source ATS aggregation and job application tracking",
  favicon: "img/favicon.ico",
  future: {
    v4: true
  },
  url: `https://${githubOwner}.github.io`,
  baseUrl: isUserSite ? "/" : `/${githubRepo}/`,
  organizationName: githubOwner,
  projectName: githubRepo,
  onBrokenLinks: "throw",
  trailingSlash: false,
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: "throw"
    }
  },
  i18n: {
    defaultLocale: "en",
    locales: ["en"]
  },
  staticDirectories: ["static", "../README-Images"],
  presets: [
    [
      "classic",
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          sidebarPath: "./sidebars.js",
          editUrl: `${githubUrl}/tree/main/docs-site/`
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css"
        }
      })
    ]
  ],
  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      image: "img/docusaurus-social-card.jpg",
      colorMode: {
        respectPrefersColorScheme: true
      },
      navbar: {
        title: "Lite",
        logo: {
          alt: "OpenPostings Logo",
          src: "img/logo.png"
        },
        items: [
          {
            type: "docSidebar",
            sidebarId: "docsSidebar",
            position: "right",
            label: "Docs"
          },
          {
            href: githubUrl,
            label: "GitHub",
            position: "right"
          }
        ]
      },
      footer: {
        style: "dark",
        links: [
          {
            title: "Docs",
            items: [{ label: "Documentation Home", to: "/docs/intro" }]
          },
          {
            title: "Project",
            items: [
              { label: "GitHub Repository", href: githubUrl },
              { label: "Releases", href: `${githubUrl}/releases` },
              { label: "Privacy Policy", to: "/privacy-policy" }
            ]
          }
        ],
        copyright: `Copyright © ${new Date().getFullYear()} OpenPostings · OpenPostings Lite syncs once daily at 14:20 UTC.`
      },
      prism: {
        theme: prismThemes.github,
        darkTheme: prismThemes.dracula
      }
    })
};

export default config;
