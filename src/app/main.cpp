// Application entry point: creates the Qt application and the main window. The window's contents (menus, panels,
// viewer) arrive with PLAN Part C item 13.

#include "app/Brand.h"

#include <QApplication>
#include <QCommandLineParser>
#include <QMainWindow>
#include <QString>

namespace {

QString toQString(std::string_view text) {
    return QString::fromUtf8(text.data(), static_cast<qsizetype>(text.size()));
}

} // namespace

int main(int argc, char* argv[]) {
    const QApplication app(argc, argv);
    QApplication::setApplicationName(toQString(pf::APP_NAME));
    QApplication::setApplicationVersion(QStringLiteral(PF_VERSION_STRING));

    QCommandLineParser parser;
    parser.addHelpOption();
    parser.addVersionOption();
    parser.process(app);

    QMainWindow window;
    window.setWindowTitle(toQString(pf::APP_NAME));
    window.resize(1280, 800);
    window.show();
    return QApplication::exec();
}
